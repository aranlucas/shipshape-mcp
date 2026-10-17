import type { EvaluationMessage } from "../env";
import type { StoredRepository } from "../practices/store";
import { jobGuard, leaseValues, type JobLease } from "./guard";

export const JOB_LEASE_MS = 10 * 60 * 1000;

export const MAX_JOB_ATTEMPTS = 3;

export interface EvaluationJob {
  id: string;
  run_id: string;
  repo_full_name: string;
  installation_id: number;
  practice_id: string | null;
  status: "pending" | "running" | "completed" | "failed" | "superseded";
  reason: EvaluationMessage["reason"];
  attempts: number;
  available_at: number;
  dispatched_at: number | null;
}

export interface RunOptions {
  id?: string;
  /** Claim and fan-out commit together; a failed Queue send cannot lose this work. */
  builtInVersion?: string;
}

/** Jobs double as an outbox. A duplicate run never advances the repository generation. */
export async function createRun(
  db: D1Database,
  repos: StoredRepository[],
  reason: EvaluationMessage["reason"],
  options: RunOptions = {},
): Promise<number> {
  if (repos.length === 0) {
    return 0;
  }

  const id = options.id ?? crypto.randomUUID();
  const createdAt = Date.now();
  const requestToken = crypto.randomUUID();

  const statements = [
    db
      .prepare(`INSERT OR IGNORE INTO evaluation_runs (id, reason, created_at, request_token)
      SELECT ?, ?, ?, ? WHERE ? IS NULL OR EXISTS (
        SELECT 1 FROM catalog WHERE id = 1 AND sha IS NOT NULL AND built_in_version IS NOT ?
      )`)
      .bind(
        id,
        reason,
        createdAt,
        requestToken,
        options.builtInVersion ?? null,
        options.builtInVersion ?? null,
      ),
  ];

  // Keep statement parameters and JSON payloads bounded for large installations.
  for (let offset = 0; offset < repos.length; offset += 100) {
    const payload = JSON.stringify(
      repos.slice(offset, offset + 100).map((repo) => ({
        repo: repo.fullName,
        installationId: repo.installationId,
      })),
    );

    statements.push(
      db
        .prepare(`INSERT INTO evaluation_heads (repo_full_name, run_id)
        SELECT json_extract(value, '$.repo'), ? FROM json_each(?)
        WHERE EXISTS (SELECT 1 FROM evaluation_runs WHERE id = ? AND request_token = ?)
        ON CONFLICT(repo_full_name) DO UPDATE SET run_id = excluded.run_id
        WHERE (SELECT sequence FROM evaluation_runs WHERE id = excluded.run_id) >
          (SELECT sequence FROM evaluation_runs WHERE id = evaluation_heads.run_id)`)
        .bind(id, payload, id, requestToken),
      db
        .prepare(`INSERT OR IGNORE INTO evaluation_jobs
        (id, run_id, repo_full_name, installation_id, available_at)
        SELECT ? || ':' || json_extract(value, '$.repo'), ?, json_extract(value, '$.repo'),
          json_extract(value, '$.installationId'), ? FROM json_each(?)
        WHERE EXISTS (SELECT 1 FROM evaluation_runs WHERE id = ? AND request_token = ?) RETURNING id`)
        .bind(id, id, createdAt, payload, id, requestToken),
    );
  }

  if (options.builtInVersion !== undefined) {
    statements.push(
      db
        .prepare(`UPDATE catalog SET built_in_version = ?
      WHERE id = 1 AND EXISTS (SELECT 1 FROM evaluation_runs WHERE id = ? AND request_token = ?)`)
        .bind(options.builtInVersion, id, requestToken),
    );
  }

  const results = await db.batch(statements);

  return results
    .filter((_result, index) => index > 0 && index % 2 === 0)
    .reduce((count, result) => count + result.results.length, 0);
}

export function readJob(db: D1Database, id: string): Promise<EvaluationJob | null> {
  return db
    .prepare(`SELECT job.*, run.reason FROM evaluation_jobs job
    JOIN evaluation_runs run ON run.id = job.run_id WHERE job.id = ?`)
    .bind(id)
    .first<EvaluationJob>();
}

interface ClaimedJob {
  id: string;
}

export async function claimJob(db: D1Database, id: string): Promise<JobLease | null> {
  const token = crypto.randomUUID();
  const now = Date.now();

  const result = await db
    .prepare(`UPDATE evaluation_jobs SET status = 'running',
    lease_token = ?, lease_until = ?, attempts = attempts + 1
    WHERE id = ? AND status = 'pending' AND available_at <= ? AND attempts < ? RETURNING id`)
    .bind(token, now + JOB_LEASE_MS, id, now, MAX_JOB_ATTEMPTS)
    .first<ClaimedJob>();

  return result !== null ? { jobId: id, token } : null;
}

export async function isCurrentJob(db: D1Database, lease: JobLease): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS current WHERE ${jobGuard()}`)
    .bind(...leaseValues(lease))
    .first();

  return row !== null;
}

export async function finishJob(
  db: D1Database,
  lease: JobLease,
  status: "completed" | "failed" | "superseded",
  failure: string | null = null,
): Promise<void> {
  await db
    .prepare(`UPDATE evaluation_jobs SET status = ?, failure = ?,
    completed_at = ?, lease_token = NULL, lease_until = NULL
    WHERE id = ? AND status = 'running' AND lease_token = ? AND lease_until > ?`)
    .bind(status, failure, new Date().toISOString(), lease.jobId, lease.token, Date.now())
    .run();
}

export async function retryJob(
  db: D1Database,
  lease: JobLease,
  delaySeconds: number,
): Promise<void> {
  await db
    .prepare(`UPDATE evaluation_jobs SET status = 'pending', available_at = ?,
    dispatched_at = NULL, lease_token = NULL, lease_until = NULL
    WHERE id = ? AND status = 'running' AND lease_token = ?`)
    .bind(Date.now() + delaySeconds * 1000, lease.jobId, lease.token)
    .run();
}

/** A parent and its practice children share one generation and retry budget. */
export async function createPracticeRetries(
  db: D1Database,
  job: EvaluationJob,
  lease: JobLease,
  practiceIds: string[],
): Promise<void> {
  await db.batch([
    db
      .prepare(`INSERT OR IGNORE INTO evaluation_jobs
      (id, run_id, repo_full_name, installation_id, practice_id, available_at, attempts)
      SELECT ? || ':practice:' || value, ?, ?, ?, value, ?, ? FROM json_each(?)
      WHERE ${jobGuard()}`)
      .bind(
        job.id,
        job.run_id,
        job.repo_full_name,
        job.installation_id,
        Date.now() + 60_000,
        job.attempts,
        JSON.stringify(practiceIds),
        ...leaseValues(lease),
      ),
    db
      .prepare(`UPDATE results SET retrying = 1 WHERE repo_full_name = ?
      AND practice_id IN (SELECT value FROM json_each(?)) AND ${jobGuard()}`)
      .bind(job.repo_full_name, JSON.stringify(practiceIds), ...leaseValues(lease)),
    db
      .prepare(`UPDATE evaluation_jobs SET status = 'completed', completed_at = ?,
      lease_token = NULL, lease_until = NULL WHERE id = ? AND lease_token = ? AND status = 'running' AND lease_until > ?`)
      .bind(new Date().toISOString(), job.id, lease.token, Date.now()),
  ]);
}

/** Recover termination before send, after send, or during an evaluation. */
export async function recoverJobs(db: D1Database): Promise<void> {
  const now = Date.now();
  await db.batch([
    db
      .prepare(`UPDATE evaluation_jobs SET status = 'superseded', completed_at = ?,
      lease_token = NULL, lease_until = NULL
      WHERE status IN ('pending', 'running') AND (
        NOT EXISTS (SELECT 1 FROM evaluation_heads head WHERE
          head.repo_full_name = evaluation_jobs.repo_full_name AND head.run_id = evaluation_jobs.run_id)
        OR NOT EXISTS (SELECT 1 FROM repositories repo WHERE
          repo.full_name = evaluation_jobs.repo_full_name AND repo.installation_id = evaluation_jobs.installation_id)
      )`)
      .bind(new Date(now).toISOString()),
    db
      .prepare(`UPDATE evaluation_jobs SET status = 'failed', failure = 'Attempt budget exhausted',
      completed_at = ?, lease_token = NULL, lease_until = NULL
      WHERE (status = 'pending' OR (status = 'running' AND lease_until <= ?)) AND attempts >= ?`)
      .bind(new Date(now).toISOString(), now, MAX_JOB_ATTEMPTS),
    db
      .prepare(`UPDATE evaluation_jobs SET status = 'pending', lease_token = NULL,
      lease_until = NULL, dispatched_at = NULL WHERE status = 'running' AND lease_until <= ?`)
      .bind(now),
    db.prepare(`UPDATE results SET retrying = 0 WHERE retrying = 1 AND NOT EXISTS (
      SELECT 1 FROM evaluation_jobs job WHERE job.repo_full_name = results.repo_full_name
        AND (job.practice_id IS NULL OR job.practice_id = results.practice_id)
        AND job.status IN ('pending', 'running')
    )`),
    // Also replace any counter left by deliveries published before migration 0006.
    db.prepare(`UPDATE sweep SET pending = (
      SELECT COUNT(*) FROM evaluation_jobs WHERE status IN ('pending', 'running')
    ) WHERE id = 1`),
  ]);
}
