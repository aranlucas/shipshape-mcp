import { z } from "zod";
import type { AppEnv, WebhookMessage } from "../env";
import { isAllowedAccount } from "../auth/owner";
import { verifyWebhookSignature } from "./webhook";

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

const installationEventSchema = z.object({
  installation: z.object({
    id: z.number().int().positive(),
    account: z.object({ login: z.string().min(1) }),
  }),
});

const objectPayloadSchema = z.record(z.string(), z.unknown());

async function readWebhookBody(request: Request): Promise<string | null> {
  if (!request.body) {
    return "";
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  // SAFETY: the Fetch API guarantees Request.body chunks are bytes; the shared DOM declaration uses an untyped stream.
  const stream = request.body as ReadableStream<Uint8Array>;

  for await (const value of stream) {
    total += value.byteLength;

    if (total > MAX_WEBHOOK_BYTES) {
      return null;
    }

    chunks.push(new Uint8Array(value));
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
}

export async function handleWebhook(request: Request, env: AppEnv): Promise<Response> {
  if (env.PREVIEW_READ_ONLY === "true") {
    return new Response("Preview is read-only", { status: 403 });
  }

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

  let payload: z.infer<typeof objectPayloadSchema>;

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
    } else {
      installationEventSchema.parse(payload);
    }
  } catch {
    return new Response(null, { status: 400 });
  }

  const deliveryId =
    request.headers.get("X-GitHub-Delivery") ??
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${event}:${body}`)),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");

  if (deliveryId.length === 0 || deliveryId.length > 128) {
    return new Response(null, { status: 400 });
  }

  let message: WebhookMessage;

  if (event === "push") {
    const push = pushPayloadSchema.parse(payload);
    const owner = push.repository.full_name.split("/")[0] ?? "";

    if (
      push.ref !== `refs/heads/${push.repository.default_branch}` ||
      !isAllowedAccount(env, owner)
    ) {
      return new Response(null, { status: 202 });
    }

    message = {
      deliveryId,
      event,
      repository: push.repository.full_name,
      installationId: push.installation.id,
      ref: push.ref,
      defaultBranch: push.repository.default_branch,
    };
  } else if (event === "repository") {
    const target = repositoryEventSchema.parse(payload);

    if (!isAllowedAccount(env, target.repository.full_name.split("/")[0] ?? "")) {
      return new Response(null, { status: 202 });
    }

    message = {
      deliveryId,
      event,
      repository: target.repository.full_name,
      installationId: target.installation.id,
    };
  } else {
    const installation = installationEventSchema.parse(payload).installation;

    if (!isAllowedAccount(env, installation.account.login)) {
      return new Response(null, { status: 202 });
    }

    message = { deliveryId, event };
  }

  try {
    await env.WEBHOOKS.send(message);
  } catch {
    return new Response("Webhook acceptance unavailable", { status: 503 });
  }

  return new Response(null, { status: 202 });
}
