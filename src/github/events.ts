import { logger } from "../logger";
import pLimit from "p-limit";
import type { AppEnv, WebhookMessage } from "../env";
import { loadCatalog } from "../practices/catalog";
import { listRepositories, type StoredRepository } from "../practices/store";
import { enqueueRepositories } from "../queue";
import { syncInventory } from "../inventory/sync";
import { createRun } from "../jobs/store";
import { tryDispatchJobs } from "../jobs/dispatch";

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

export async function processWebhook(message: WebhookMessage, env: AppEnv): Promise<void> {
  const runId = `webhook:${message.deliveryId}`;

  const existing = await env.DB.prepare("SELECT 1 FROM evaluation_runs WHERE id = ?")
    .bind(runId)
    .first();

  if (existing) {
    await tryDispatchJobs(env);

    return;
  }

  if (message.event === "push") {
    if (message.repository.toLowerCase() === env.CATALOG_REPO.toLowerCase()) {
      // Always persist the intent even if another delivery already loaded this commit.
      await loadCatalog(env);
      await enqueueRepositories(env, await listRepositories(env.DB), "catalog", { id: runId });
    } else {
      await enqueueRepositories(
        env,
        [queuedRepository(message.repository, message.installationId, message.defaultBranch)],
        "push",
        { id: runId },
      );
    }

    return;
  }

  // Ingress can retry durably. Do not acknowledge a stale inventory fallback here.
  const after = await syncInventory(env);

  const targets =
    message.event === "repository"
      ? after.filter((repo) => repo.fullName === message.repository)
      : after;

  await createRun(env.DB, targets, "installation", { id: runId });
  await tryDispatchJobs(env);
}

export async function handleWebhookQueue(
  batch: MessageBatch<WebhookMessage>,
  env: AppEnv,
): Promise<void> {
  const limit = pLimit(1);
  await Promise.all(batch.messages.map((message) => limit(() => processDelivery(message, env))));
}

async function processDelivery(message: Message<WebhookMessage>, env: AppEnv): Promise<void> {
  try {
    await processWebhook(message.body, env);
    message.ack();
  } catch {
    logger.error(
      {
        deliveryId: message.body.deliveryId,
        event: message.body.event,
        attempt: message.attempts,
      },
      "webhook_processing_failed",
    );
    message.retry({ delaySeconds: 60 });
  }
}
