export interface JobLease {
  jobId: string;
  token: string;
}

export interface EvaluationGuard extends JobLease {
  catalogCommit: string;
}

/** Every write checks ownership in SQL, including after a lease expires mid-read. */
export function jobGuard(): string {
  return `EXISTS (
    SELECT 1 FROM evaluation_jobs job
    JOIN evaluation_heads head ON head.repo_full_name = job.repo_full_name
    JOIN repositories repository ON repository.full_name = job.repo_full_name
    WHERE job.id = ? AND job.lease_token = ? AND job.status = 'running'
      AND job.lease_until > ? AND head.run_id = job.run_id
      AND repository.installation_id = job.installation_id
  )`;
}

type LeaseValues = [string, string, number];

export function leaseValues(lease: JobLease): LeaseValues {
  return [lease.jobId, lease.token, Date.now()];
}

export function evaluationGuardSql(guard?: EvaluationGuard): string {
  return guard
    ? `${jobGuard()} AND EXISTS (SELECT 1 FROM catalog WHERE id = 1 AND sha = ?)`
    : "true";
}

export function evaluationGuardValues(guard?: EvaluationGuard): (string | number)[] {
  return guard ? [...leaseValues(guard), guard.catalogCommit] : [];
}
