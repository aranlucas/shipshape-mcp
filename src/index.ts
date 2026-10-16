/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/require-readable-spacing, no-await-in-loop */

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

import { verifyWebhookSignature } from "./github/webhook";

import { MCP_SCOPE } from "./config";
import { isAllowedAccount, isOwner } from "./auth/owner";
import type { AppEnv } from "./env";
import { GitHubOwnerInputSchema } from "./github/schemas";
import { loadCatalog } from "./practices/catalog";
import { listRepositories, readCatalogRow, type StoredRepository } from "./practices/store";
import { enqueueRepositories, handleQueue } from "./queue";
import { handleScheduled, inventoryForTrigger } from "./scheduled";
import { createPracticesServer } from "./mcp";
import { callbackUrl, type OAuthEnv } from "./oauth";
import { defaultHandler } from "./oauth-runtime";

const mcpOptions = { route: "/mcp", legacy: "stateless" } as const;
const protectedIdentitySchema = z
  .object({
    login: GitHubOwnerInputSchema,
    userId: z.number().int().positive(),
  })
  .strict();

const protectedHandler = {
  fetch(request, env, ctx) {
    const identity = protectedIdentitySchema.safeParse(ctx.props);

    if (!identity.success || !isOwner(env, identity.data)) {
      return new Response("Forbidden", { status: 403 });
    }

    // SAFETY: OAuthProvider passes the Worker bindings through to the protected API handler.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    return createMcpHandler(() => createPracticesServer(env as unknown as AppEnv), mcpOptions)(
      request,
      env,
      ctx,
    );
  },
} satisfies ProtectedHandler;

function createProvider(origin: string) {
  return new OAuthProvider<OAuthEnv>({
    apiRoute: "/mcp",
    apiHandler: protectedHandler,
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    // Preserve native MCP clients such as Claude alongside HTTPS and loopback callbacks.
    allowPrivateUseRedirectUris: true,
    scopesSupported: [MCP_SCOPE],
    requiredScopes: [MCP_SCOPE],
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      resource_name: "Shipshape MCP",
    },
    clientIdMetadataDocumentEnabled: true,
  });
}

const MAX_WEBHOOK_BYTES = 5 * 1024 * 1024;

const pushPayloadSchema = z.object({
  ref: z.string(),
  repository: z.object({ full_name: z.string().min(1), default_branch: z.string().min(1) }),
  installation: z.object({ id: z.number().int().positive() }),
});

const repositoryEventSchema = z.object({
  repository: z.object({ full_name: z.string().min(1) }),
  installation: z.object({ id: z.number().int().positive() }),
});

const objectPayloadSchema = z.record(z.string(), z.unknown());

async function readWebhookBody(request: Request): Promise<string | null> {
  if (!request.body) {
    return "";
  }

  // SAFETY: the platform Request body reader yields byte chunks; the bounded loop below limits total memory.
  const reader = request.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      total += value.byteLength;

      if (total > MAX_WEBHOOK_BYTES) {
        await reader.cancel();
        return null;
      }

      chunks.push(new Uint8Array(value));
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
}

function queuedRepository(
  fullName: string,
  installationId: number,
  defaultBranch = "main",
): StoredRepository {
  const separator = fullName.indexOf("/");

  return {
    fullName,
    owner: fullName.slice(0, separator),
    name: fullName.slice(separator + 1),
    installationId,
    private: false,
    archived: false,
    fork: false,
    language: null,
    defaultBranch,
    pushedAt: null,
    url: `https://github.com/${fullName}`,
  };
}

function repositoryChanged(before: StoredRepository | undefined, after: StoredRepository): boolean {
  if (!before) {
    return true;
  }

  return (
    before.installationId !== after.installationId ||
    before.private !== after.private ||
    before.archived !== after.archived ||
    before.fork !== after.fork ||
    before.language !== after.language ||
    before.defaultBranch !== after.defaultBranch ||
    before.pushedAt !== after.pushedAt ||
    before.url !== after.url
  );
}

async function handleWebhookWork(
  event: string,
  payload: Record<string, unknown>,
  env: AppEnv,
): Promise<void> {
  if (event === "push") {
    const push = pushPayloadSchema.parse(payload);

    const owner = push.repository.full_name.split("/")[0] ?? "";

    if (
      push.ref !== `refs/heads/${push.repository.default_branch}` ||
      !isAllowedAccount(env, owner)
    ) {
      return;
    }

    if (push.repository.full_name.toLowerCase() === env.CATALOG_REPO.toLowerCase()) {
      const previousSha = (await readCatalogRow(env.DB))?.sha;
      const catalog = await loadCatalog(env);

      // Dashboard saves load and enqueue their own commit before GitHub delivers this push.
      if (catalog.sha !== previousSha) {
        await enqueueRepositories(env, await listRepositories(env.DB), "catalog");
      }
      return;
    }

    await enqueueRepositories(
      env,
      [
        queuedRepository(
          push.repository.full_name,
          push.installation.id,
          push.repository.default_branch,
        ),
      ],
      "push",
    );
    return;
  }

  if (event === "installation" || event === "installation_repositories" || event === "repository") {
    const before = new Map((await listRepositories(env.DB)).map((repo) => [repo.fullName, repo]));
    const { repos: after, refreshed } = await inventoryForTrigger(env);

    if (event === "repository") {
      const target = repositoryEventSchema.parse(payload);
      const targetRepo = after.find((repo) => repo.fullName === target.repository.full_name);

      await enqueueRepositories(env, targetRepo ? [targetRepo] : [], "installation");
      return;
    }

    await enqueueRepositories(
      env,
      refreshed
        ? after.filter((repo) => repositoryChanged(before.get(repo.fullName), repo))
        : after,
      "installation",
    );
  }
}

async function handleWebhook(
  request: Request,
  env: AppEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }

  const body = await readWebhookBody(request);

  if (body === null) {
    return new Response(null, { status: 413 });
  }

  const valid = await verifyWebhookSignature(
    env.GITHUB_WEBHOOK_SECRET,
    body,
    request.headers.get("X-Hub-Signature-256"),
  );

  if (!valid) {
    return new Response(null, { status: 401 });
  }

  let payload: Record<string, unknown>;

  try {
    payload = objectPayloadSchema.parse(JSON.parse(body));
  } catch {
    return new Response(null, { status: 400 });
  }

  const event = request.headers.get("X-GitHub-Event") ?? "";

  if (event === "ping") {
    return new Response(null, { status: 200 });
  }

  if (
    event !== "push" &&
    event !== "installation" &&
    event !== "installation_repositories" &&
    event !== "repository"
  ) {
    return new Response(null, { status: 204 });
  }

  try {
    if (event === "push") {
      pushPayloadSchema.parse(payload);
    } else if (event === "repository") {
      repositoryEventSchema.parse(payload);
    }
  } catch {
    return new Response(null, { status: 400 });
  }

  ctx.waitUntil(handleWebhookWork(event, payload, env));
  return new Response(null, { status: 202 });
}

const worker = {
  fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === "/github/webhook") {
      return handleWebhook(request, env, ctx);
    }

    return createProvider(callbackUrl(request, env, "/").origin).fetch(request, env, ctx);
  },
  queue: handleQueue,
  scheduled(_controller: ScheduledController, env: AppEnv, ctx: ExecutionContext): void {
    ctx.waitUntil(handleScheduled(env));
  },
};

type ProtectedHandler = { fetch: ExportedHandlerFetchHandler<OAuthEnv> };

export default worker;
