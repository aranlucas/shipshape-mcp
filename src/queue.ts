/* oxlint-disable no-await-in-loop, anti-slop/require-readable-spacing */

import type { AppEnv, EvaluationMessage } from "./env";
import { evaluateRepository } from "./practices/evaluate";
import {
  completePendingMessage,
  decrementPending,
  getRepository,
  incrementPending,
  type StoredRepository,
} from "./practices/store";

const MAX_BATCH_SIZE = 100;
const MAX_EVALUATION_ATTEMPTS = 3;

export async function enqueueRepositories(
  env: AppEnv,
  repos: StoredRepository[],
  reason: EvaluationMessage["reason"],
): Promise<number> {
  await incrementPending(env.DB, repos.length);

  let queued = 0;

  try {
    for (let offset = 0; offset < repos.length; offset += MAX_BATCH_SIZE) {
      const chunk = repos.slice(offset, offset + MAX_BATCH_SIZE);
      const messages = chunk.map((repo) => ({
        body: {
          repo: repo.fullName,
          installationId: repo.installationId,
          reason,
        },
      }));

      await env.EVALUATIONS.sendBatch(messages);
      queued += chunk.length;
    }
  } catch (error) {
    await decrementPending(env.DB, repos.length - queued);
    throw error;
  }

  return queued;
}

export async function handleQueue(
  batch: MessageBatch<EvaluationMessage>,
  env: AppEnv,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      const repository = await getRepository(env.DB, message.body.repo);

      if (!repository) {
        await completePendingMessage(env.DB);
        message.ack();
        continue;
      }

      const outcome = await evaluateRepository(env, message.body.repo, {
        force:
          message.body.reason === "manual" ||
          message.body.reason === "catalog" ||
          message.body.reason === "installation" ||
          message.body.reason === "sweep",
      });

      if (outcome === "retry" && message.attempts < MAX_EVALUATION_ATTEMPTS) {
        message.retry({ delaySeconds: 60 * message.attempts });
        continue;
      }

      await completePendingMessage(env.DB);
      message.ack();
    } catch {
      try {
        if (!(await getRepository(env.DB, message.body.repo))) {
          await completePendingMessage(env.DB);
          message.ack();
          continue;
        }
      } catch {
        // Fall through to the retry path when inventory availability is itself uncertain.
      }

      message.retry({ delaySeconds: 60 });
    }
  }
}
