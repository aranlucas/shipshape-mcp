import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

import { Hono } from "hono";
import { handleWebhook } from "./github/webhook-route";

import { MCP_SCOPE } from "./config";
import { isOwner } from "./auth/owner";
import type { AppEnv, EvaluationMessage, WebhookMessage } from "./env";
import { handleWebhookQueue } from "./github/events";
import { reconcileJobs } from "./jobs/dispatch";
import { GitHubOwnerInputSchema } from "./github/schemas";
import { handleQueue, requeueIfBuiltInsChanged } from "./queue";
import { handleScheduled } from "./scheduled";
import { createPracticesServer } from "./mcp";
import { callbackUrl } from "./oauth";
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

    const appEnv = env;

    ctx.waitUntil(requeueIfBuiltInsChanged(appEnv));

    return createMcpHandler(() => createPracticesServer(appEnv), mcpOptions)(request, env, ctx);
  },
} satisfies ProtectedHandler;

function createProvider(origin: string) {
  return new OAuthProvider<AppEnv>({
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

interface HttpEnv {
  Bindings: AppEnv;
}

const app = new Hono<HttpEnv>();

app.all("/github/webhook", (c) => handleWebhook(c.req.raw, c.env));

app.all("*", (c) =>
  // SAFETY: app.fetch receives the native Worker context; Hono types expose only its common subset.
  createProvider(callbackUrl(c.req.raw, c.env, "/").origin).fetch(
    c.req.raw,
    c.env,
    c.executionCtx as ExecutionContext,
  ),
);

const worker = {
  fetch: app.fetch,
  queue(
    batch: MessageBatch<EvaluationMessage> | MessageBatch<WebhookMessage>,
    env: AppEnv,
  ): Promise<void> {
    if (batch.queue.endsWith("-webhooks")) {
      // SAFETY: each configured queue has one producer schema and its corresponding consumer.
      return handleWebhookQueue(batch as MessageBatch<WebhookMessage>, env);
    }

    // SAFETY: the other configured consumer is the evaluation queue.
    return handleQueue(batch as MessageBatch<EvaluationMessage>, env);
  },
  scheduled(controller: ScheduledController, env: AppEnv, ctx: ExecutionContext): void {
    ctx.waitUntil(controller.cron === "0 13 * * *" ? handleScheduled(env) : reconcileJobs(env));
  },
};

type ProtectedHandler = { fetch: ExportedHandlerFetchHandler<AppEnv> };

export default worker;
