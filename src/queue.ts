import { logger } from "./logger";
import pLimit from "p-limit";
import type { AppEnv, EvaluationMessage } from "./env";
import { tryDispatchJobs } from "./jobs/dispatch";
import { type JobLease } from "./jobs/guard";
import {
  claimJob,
  createPracticeRetries,
  createRun,
  finishJob,
  isCurrentJob,
  MAX_JOB_ATTEMPTS,
  readJob,
  retryJob,
  type EvaluationJob,
  type RunOptions,
} from "./jobs/store";
import { bundledBuiltIns } from "./practices/built-in";
import { readStoredCatalog } from "./practices/catalog";
import { evaluateRepository, EvaluationCooldown } from "./practices/evaluate";
import {
  getRepository,
  listRepositories,
  readResults,
  setResultsRetrying,
  type StoredRepository,
} from "./practices/store";

export async function enqueueRepositories(
  env: AppEnv,
  repos: StoredRepository[],
  reason: EvaluationMessage["reason"],
  options: RunOptions = {},
): Promise<number> {
  const count = await createRun(env.DB, repos, reason, options);
  await tryDispatchJobs(env);

  return count;
}

async function retryPractices(env: AppEnv, job: EvaluationJob, lease: JobLease): Promise<boolean> {
  const [catalog, results] = await Promise.all([
    readStoredCatalog(env.DB),
    readResults(env.DB, job.repo_full_name),
  ]);

  const ids = results
    .filter(
      (result) =>
        result.catalogSha === catalog?.sha &&
        result.cell.unknown > 0 &&
        catalog?.practices.some(
          (practice) => practice.id === result.practiceId && practice.parsed.ok,
        ),
    )
    .map((result) => result.practiceId);

  if (ids.length === 0) {
    return false;
  }

  await createPracticeRetries(env.DB, job, lease, ids);

  return true;
}

/** Adopt old in-flight deliveries once, without trusting them as current job metadata. */
async function jobIdFor(message: Message<EvaluationMessage>, env: AppEnv): Promise<string | null> {
  if (message.body.jobId) {
    return message.body.jobId;
  }

  const repo = await getRepository(env.DB, message.body.repo);

  if (!repo) {
    return null;
  }

  const runId = `legacy:${message.id}`;
  await createRun(env.DB, [repo], message.body.reason, { id: runId });

  return `${runId}:${repo.fullName}`;
}

async function evaluateJob(env: AppEnv, job: EvaluationJob, lease: JobLease): Promise<void> {
  if (!(await isCurrentJob(env.DB, lease))) {
    await finishJob(env.DB, lease, "superseded");

    return;
  }

  try {
    const options: Parameters<typeof evaluateRepository>[2] = {
      force: job.reason === "installation",
      lease,
    };

    if (job.practice_id) {
      options.practiceId = job.practice_id;
    }

    const outcome = await evaluateRepository(env, job.repo_full_name, options);
    const rateLimited = outcome instanceof EvaluationCooldown;
    const needsRetry = outcome === "retry" || rateLimited;

    if (needsRetry && job.attempts < MAX_JOB_ATTEMPTS) {
      if (rateLimited || job.practice_id || !(await retryPractices(env, job, lease))) {
        await retryJob(env.DB, lease, rateLimited ? outcome.retryAfterSeconds : 60 * job.attempts);
      }

      return;
    }

    if (job.practice_id) {
      await setResultsRetrying(env.DB, job.repo_full_name, [job.practice_id], false, lease);
    }

    await finishJob(
      env.DB,
      lease,
      needsRetry ? "failed" : "completed",
      needsRetry ? "GitHub reads unavailable after retries" : null,
    );
  } catch (error) {
    logger.error(
      {
        jobId: job.id,
        runId: job.run_id,
        repo: job.repo_full_name,
        attempt: job.attempts,
        category: error instanceof Error ? error.name : "Error",
      },
      "evaluation_failed",
    );

    if (job.attempts >= MAX_JOB_ATTEMPTS) {
      if (job.practice_id) {
        await setResultsRetrying(env.DB, job.repo_full_name, [job.practice_id], false, lease);
      }

      await finishJob(env.DB, lease, "failed", "Evaluation could not finish");
    } else {
      await retryJob(env.DB, lease, 60 * job.attempts);
    }
  }
}

async function handleMessage(message: Message<EvaluationMessage>, env: AppEnv): Promise<void> {
  try {
    const id = await jobIdFor(message, env);

    if (!id) {
      message.ack();

      return;
    }

    const lease = await claimJob(env.DB, id);

    if (lease) {
      const job = await readJob(env.DB, id);

      if (job) {
        await evaluateJob(env, job, lease);
      }
    }

    // A duplicate of a running/terminal job is harmless. Expired leases are reconciled.
    message.ack();
  } catch {
    // No durable state transition could be established; preserve the platform delivery.
    message.retry({ delaySeconds: 60 });
  }
}

export async function handleQueue(
  batch: MessageBatch<EvaluationMessage>,
  env: AppEnv,
): Promise<void> {
  const limit = pLimit(3);
  await Promise.all(batch.messages.map((message) => limit(() => handleMessage(message, env))));
  await tryDispatchJobs(env);
}

export async function requeueIfBuiltInsChanged(env: AppEnv): Promise<void> {
  if (env.PREVIEW_READ_ONLY === "true") {
    return;
  }

  const builtIns = bundledBuiltIns();

  if (builtIns.practices.length === 0) {
    return;
  }

  await enqueueRepositories(env, await listRepositories(env.DB), "catalog", {
    builtInVersion: builtIns.version,
  });
}
