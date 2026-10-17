import type { StoredRepository } from "./store";

// Bump when evaluator semantics change so persisted results are recomputed on refresh.
const EVALUATOR_VERSION = 1;

export function evaluationKey(repo: StoredRepository): string {
  return JSON.stringify([
    EVALUATOR_VERSION,
    repo.installationId,
    repo.defaultBranch,
    repo.private,
    repo.archived,
    repo.fork,
    repo.language,
  ]);
}
