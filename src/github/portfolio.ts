import { evaluateRepositoryReadiness } from "../domain/evaluate";
import { buildActionPlan, scoreChecks } from "../domain/scoring";
import type { GitHubOctokit } from "./client";
import { collectPortfolioSnapshot } from "./collectors";

/** Bounded portfolio selection, evidence and ranking shared by tool callers. */
export async function collectPortfolioReport(
  client: GitHubOctokit,
  owner: string,
  options: { limit: number; includeForks: boolean; includeArchived: boolean },
) {
  const snapshot = await collectPortfolioSnapshot(client, owner, {
    ...options,
    limit: Math.min(options.limit, 8),
    listing: { maxPages: 1, perPage: 50 },
    concurrency: Math.min(4, options.limit),
    maxPages: 1,
    perPage: 20,
  });
  const results = snapshot.repositories.map((readiness) => {
    const checks = evaluateRepositoryReadiness(readiness);
    return {
      repository: readiness.repository.fullName,
      status: readiness.status,
      deliveryCoverage: readiness.deliveryHygiene.coverage,
      score: scoreChecks(checks),
      nextActions: buildActionPlan(checks, { maxItems: 3 }).items,
    };
  });
  results.sort(
    (left, right) =>
      (left.score.score ?? 101) - (right.score.score ?? 101) ||
      left.repository.localeCompare(right.repository),
  );
  return {
    owner: snapshot.owner,
    status: snapshot.status,
    scannedRepositories: results.length,
    // Compatibility count: exact/lower-bound semantics live in scope.listing.
    availableRepositories: snapshot.scope.listing?.fetchedCount ?? null,
    scope: snapshot.scope,
    results,
    collectedAt: snapshot.collectedAt,
  };
}
