import { Hono } from "hono";

import { protectedMcp, resourceMetadata } from "./auth/mcp";
import type { AppEnv, EvaluationMessage, WebhookMessage } from "./env";
import { handleWebhook } from "./github/webhook-route";
import { handleWebhookQueue } from "./github/events";
import { reconcileJobs } from "./jobs/dispatch";
import { handleQueue } from "./queue";
import { handleScheduled } from "./scheduled";
import { landingHandler } from "./landing";
import { logger } from "./logger";
import { securityHeaders } from "./oauth-security";
import { isWebPath, webHandler } from "./web/routes";

interface HttpEnv {
  Bindings: AppEnv;
}

const app = new Hono<HttpEnv>();

app.all("/github/webhook", (c) => handleWebhook(c.req.raw, c.env));

app.all("/.well-known/oauth-protected-resource", (c) => resourceMetadata(c.req.raw, c.env));

app.all("/.well-known/oauth-protected-resource/mcp", (c) => resourceMetadata(c.req.raw, c.env));

app.all("/mcp", (c) =>
  // SAFETY: Hono receives the native Worker context, but exposes only its common subset.
  protectedMcp(c.req.raw, c.env, c.executionCtx as ExecutionContext),
);

app.all("*", (c) =>
  // SAFETY: Hono receives the native Worker context, but exposes only its common subset.
  isWebPath(c.req.path)
    ? webHandler(c.req.raw, c.env, c.executionCtx as ExecutionContext)
    : landingHandler(c.req.raw),
);

app.onError((_error, c) => {
  logger.error({ path: c.req.path }, "request_failed");

  return new Response("Service unavailable", { status: 503, headers: securityHeaders() });
});

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

export default worker;
