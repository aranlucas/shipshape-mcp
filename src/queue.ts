/* oxlint-disable no-await-in-loop, anti-slop/require-readable-spacing */

import type { AppEnv, EvaluationMessage } from "./env";
import pLimit from "p-limit";
import { bundledBuiltIns } from "./practices/built-in";
import { readStoredCatalog } from "./practices/catalog";
import { evaluateRepository } from "./practices/evaluate";
import {
  claimBuiltInVersion,
  completePendingMessage,
  decrementPending,
  getRepository,
  incrementPending,
  listRepositories,
  readResults,
  setResultsRetrying,
  type StoredRepository,
} from "./practices/store";

const MAX_BATCH_SIZE = 100;
const MAX_EVALUATION_ATTEMPTS = 3;

async function queuePracticeRetries(env: AppEnv, body: EvaluationMessage): Promise<boolean> {
  const [catalog, results] = await Promise.all([
    readStoredCatalog(env.DB),
    readResults(env.DB, body.repo),
  ]);
  const practiceIds = results
    .filter(
      (result) =>
        result.catalogSha === catalog?.sha &&
        result.cell.unknown > 0 &&
        catalog?.practices.some(
          (practice) => practice.id === result.practiceId && practice.parsed.ok,
        ),
    )
    .map((result) => result.practiceId);

  if (practiceIds.length === 0) {
    return false;
  }

  await setResultsRetrying(env.DB, body.repo, practiceIds, true);
  await incrementPending(env.DB, practiceIds.length);
  let queued = 0;

  try {
    // Publish separately so a slow or failing practice has its own delivery and retry budget.
    for (let offset = 0; offset < practiceIds.length; offset += MAX_BATCH_SIZE) {
      const chunk = practiceIds.slice(offset, offset + MAX_BATCH_SIZE);
      await env.EVALUATIONS.sendBatch(
        chunk.map((practiceId) => ({ body: { ...body, practiceId }, delaySeconds: 60 })),
      );
      queued += chunk.length;
    }
  } catch (error) {
    await decrementPending(env.DB, practiceIds.length - queued);
    await setResultsRetrying(env.DB, body.repo, practiceIds.slice(queued), false);
    throw error;
  }

  return true;
}

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
  const limit = pLimit(3);
  await Promise.all(batch.messages.map((message) => limit(() => handleMessage(message, env))));
}

async function handleMessage(message: Message<EvaluationMessage>, env: AppEnv): Promise<void> {
  // Practice deliveries start after the repository's first attempt.
  const maxAttempts = message.body.practiceId
    ? MAX_EVALUATION_ATTEMPTS - 1
    : MAX_EVALUATION_ATTEMPTS;

  try {
    const repository = await getRepository(env.DB, message.body.repo);

    if (!repository) {
      await completePendingMessage(env.DB);
      message.ack();
      return;
    }

    const options: Parameters<typeof evaluateRepository>[2] = {
      // Installation changes require a new permission check even at the same commit.
      force: message.body.reason === "installation",
    };

    if (message.body.practiceId) {
      options.practiceId = message.body.practiceId;
    }

    const outcome = await evaluateRepository(env, message.body.repo, options);

    if (outcome === "retry" && message.attempts < maxAttempts) {
      if (!message.body.practiceId && (await queuePracticeRetries(env, message.body))) {
        await completePendingMessage(env.DB);
        message.ack();
        return;
      }

      if (message.body.practiceId) {
        await setResultsRetrying(env.DB, message.body.repo, [message.body.practiceId], true);
      }
      message.retry({ delaySeconds: 60 * (message.attempts + (message.body.practiceId ? 1 : 0)) });
      return;
    }

    if (message.body.practiceId) {
      await setResultsRetrying(env.DB, message.body.repo, [message.body.practiceId], false);
    }

    await completePendingMessage(env.DB);
    message.ack();
  } catch {
    try {
      if (!(await getRepository(env.DB, message.body.repo))) {
        await completePendingMessage(env.DB);
        message.ack();
        return;
      }

      if (message.attempts >= maxAttempts) {
        if (message.body.practiceId) {
          // A redelivery past this point would be dropped by the queue without completing pending.
          await setResultsRetrying(
            env.DB,
            message.body.repo,
            [message.body.practiceId],
            false,
          ).catch(() => {});
        }
        await completePendingMessage(env.DB);
        message.ack();
        return;
      }
    } catch {
      // Fall through to the retry path when inventory availability is itself uncertain.
    }

    message.retry({ delaySeconds: 60 });
  }
}

/**
 * A deploy that changes built-in practices changes the catalog version, which
 * hides every stored result. Requeue once, from whichever caller notices first.
 */
export async function requeueIfBuiltInsChanged(env: AppEnv): Promise<void> {
  const builtIns = bundledBuiltIns();

  if (builtIns.practices.length === 0 || !(await claimBuiltInVersion(env.DB, builtIns.version))) {
    return;
  }

  await enqueueRepositories(env, await listRepositories(env.DB), "catalog");
}
