import { logger } from "../logger";
import type { AppEnv, EvaluationMessage } from "../env";
import { type EvaluationJob, JOB_LEASE_MS, recoverJobs } from "./store";

function messageFor(job: EvaluationJob): EvaluationMessage {
  const body: EvaluationMessage = {
    jobId: job.id,
    repo: job.repo_full_name,
    installationId: job.installation_id,
    reason: job.reason,
  };

  if (job.practice_id) {
    body.practiceId = job.practice_id;
  }

  return body;
}

/** Delivery is at least once; the persisted job owns the processing identity. */
export async function dispatchJobs(env: AppEnv): Promise<void> {
  await dispatchBatch(env, 10);
}

async function dispatchBatch(env: AppEnv, remaining: number): Promise<void> {
  if (remaining === 0) {
    return;
  }

  const now = Date.now();

  const { results: jobs } = await env.DB.prepare(`SELECT job.*, run.reason FROM evaluation_jobs job
      JOIN evaluation_runs run ON run.id = job.run_id
      WHERE job.status = 'pending' AND job.available_at <= ? AND (job.dispatched_at IS NULL
        OR (job.dispatched_at < ? AND job.available_at < ?))
      ORDER BY job.available_at, job.id LIMIT 100`)
    .bind(now + 3_600_000, now - JOB_LEASE_MS, now - JOB_LEASE_MS)
    .all<EvaluationJob>();

  if (jobs.length === 0) {
    return;
  }

  await env.EVALUATIONS.sendBatch(
    jobs.map((job) => {
      const message: MessageSendRequest<EvaluationMessage> = { body: messageFor(job) };
      const delay = Math.max(0, Math.min(3600, Math.ceil((job.available_at - now) / 1000)));

      if (delay > 0) {
        message.delaySeconds = delay;
      }

      return message;
    }),
  );
  // A fast consumer may already have completed or rescheduled a job.
  await env.DB.prepare(`UPDATE evaluation_jobs SET dispatched_at = ?
      WHERE status = 'pending' AND EXISTS (SELECT 1 FROM json_each(?) item
        WHERE json_extract(item.value, '$.id') = evaluation_jobs.id
          AND json_extract(item.value, '$.available_at') = evaluation_jobs.available_at)`)
    .bind(now, JSON.stringify(jobs.map((job) => ({ id: job.id, available_at: job.available_at }))))
    .run();

  await dispatchBatch(env, remaining - 1);
}

/** Failure here leaves the outbox intact for the minute reconciliation trigger. */
export async function tryDispatchJobs(env: AppEnv): Promise<void> {
  try {
    await dispatchJobs(env);
  } catch {
    logger.error({ category: "queue_or_database_unavailable" }, "evaluation_dispatch_deferred");
  }
}

export async function reconcileJobs(env: AppEnv): Promise<void> {
  await recoverJobs(env.DB);
  await dispatchJobs(env);
}
