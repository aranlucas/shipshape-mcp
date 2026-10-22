import { z } from "zod";

import type { AppEnv } from "../env";
import type { JobLease, EvaluationGuard } from "../jobs/guard";
import type { CheckResult } from "../api/contract";
import { installationClient } from "../github/app";
import { githubErrorStatus, octokitGet, type GitHubOctokit } from "../github/client";
import { GitHubSnapshotCache } from "../github/snapshot-cache";
import { rateLimitDelay } from "../github/rate-limit";
import { loadCatalog, readStoredCatalog, type CatalogPractice } from "./catalog";
import { applies } from "./applies";
import { evaluationKey } from "./evaluation-key";
import { aggregate, runCheck } from "./checks";
import {
  deleteResultsNotIn,
  getRepository,
  markUnknown,
  readResults,
  type StoredResult,
  type StoredRepository,
  writeResults,
} from "./store";
import { takeSnapshot, type PreloadedHead } from "./snapshot";

type HeadRepository = Pick<StoredRepository, "owner" | "name" | "defaultBranch">;

interface EvaluationOptions {
  force?: boolean;
  practiceId?: string;
  lease?: JobLease;
}

export class EvaluationCooldown {
  constructor(readonly retryAfterSeconds: number) {}
}

type EvaluationOutcome = "evaluated" | "skipped" | "unavailable" | "retry" | EvaluationCooldown;

const SHA = z.string().regex(/^[a-f0-9]{40}$/u);

function isTransientGitHubError(status: number | undefined): boolean {
  return status !== undefined && status >= 500 && status < 600;
}

function headError(status: number | undefined): string {
  return status === 409 ? "Repository has no commits" : "Repository head could not be read.";
}

async function readHead(client: GitHubOctokit, repo: HeadRepository): Promise<PreloadedHead> {
  try {
    const response = await octokitGet(
      client,
      "GET /repos/{owner}/{repo}/commits/{ref}",
      { owner: repo.owner, repo: repo.name, ref: repo.defaultBranch },
      z.object({ sha: SHA }),
    );

    return { sha: response.data.sha };
  } catch (error) {
    return { sha: null, error: headError(githubErrorStatus(error)) };
  }
}

function availabilityCheck(detail: string): CheckResult {
  return {
    type: "evaluation",
    label: "Evaluation availability",
    state: "unknown",
    path: null,
    expected: null,
    actual: null,
    detail,
  };
}

function invalidResult(
  repo: string,
  practice: CatalogPractice,
  headSha: string | null,
  catalogSha: string,
): StoredResult {
  return {
    repo,
    practiceId: practice.id,
    cell: {
      state: "unknown",
      checkedAt: new Date().toISOString(),
      failing: 0,
      unknown: 1,
    },
    checks: [],
    headSha,
    catalogSha,
  };
}

function evaluatePractice(
  repo: string,
  practice: CatalogPractice,
  snapshot: Awaited<ReturnType<typeof takeSnapshot>>,
  catalogSha: string,
): StoredResult {
  const checkedAt = new Date().toISOString();

  if (!practice.parsed.ok) {
    return invalidResult(repo, practice, snapshot.headSha, catalogSha);
  }

  const applicability = applies(practice.parsed.practice, snapshot.repo, snapshot);

  if (applicability === false) {
    return {
      repo,
      practiceId: practice.id,
      cell: { state: "not_applicable", checkedAt, failing: 0, unknown: 0 },
      checks: [],
      headSha: snapshot.headSha,
      catalogSha,
    };
  }

  if (applicability === "unknown") {
    return {
      repo,
      practiceId: practice.id,
      cell: { state: "unknown", checkedAt, failing: 0, unknown: 1 },
      checks: [availabilityCheck("Repository applicability could not be determined.")],
      headSha: snapshot.headSha,
      catalogSha,
    };
  }

  const checks = practice.parsed.practice.checks.map((check) =>
    runCheck(check, snapshot, practice.files),
  );

  const summary = aggregate(checks);

  return {
    repo,
    practiceId: practice.id,
    cell: { ...summary, checkedAt },
    checks,
    headSha: snapshot.headSha,
    catalogSha,
  };
}

export async function evaluateRepository(
  env: AppEnv,
  fullName: string,
  options: EvaluationOptions = {},
): Promise<EvaluationOutcome> {
  const storedCatalog = await readStoredCatalog(env.DB);
  const catalog = storedCatalog ?? (await loadCatalog(env));

  const guard: EvaluationGuard | undefined = options.lease
    ? { ...options.lease, catalogCommit: catalog.commit ?? catalog.sha }
    : undefined;

  let practices = options.practiceId
    ? catalog.practices.filter((practice) => practice.id === options.practiceId)
    : catalog.practices;

  if (options.practiceId && practices.length === 0) {
    return "skipped";
  }

  const repo = await getRepository(env.DB, fullName);

  if (!repo) {
    throw new Error(`Repository ${fullName} is not in the inventory`);
  }

  let client: GitHubOctokit;

  try {
    client = await installationClient(env, repo.installationId, { retry: "bounded" });
  } catch (error) {
    // Any installation token failure means this repository is unavailable for this run.
    await markUnknown(
      env.DB,
      fullName,
      { ...catalog, practices },
      "GitHub App installation unavailable",
      guard,
    );
    const retryAfterSeconds = rateLimitDelay(error);

    return retryAfterSeconds !== undefined
      ? new EvaluationCooldown(retryAfterSeconds)
      : isTransientGitHubError(githubErrorStatus(error))
        ? "retry"
        : "unavailable";
  }

  let retryableReadFailure = false;
  let retryAfterSeconds: number | undefined;

  // This outer hook sees only failures that exhaust Octokit's request-level retries.
  client.hook.error("request", (error, request) => {
    const delay = rateLimitDelay(error);

    if (delay !== undefined) {
      retryAfterSeconds = Math.max(retryAfterSeconds ?? 0, delay);
    }

    if (request.method === "GET" && isTransientGitHubError(githubErrorStatus(error))) {
      retryableReadFailure = true;
    }

    throw error;
  });

  const preloadedHead = await readHead(client, repo);
  const previousResults = await readResults(env.DB, fullName);
  const previousById = new Map(previousResults.map((result) => [result.practiceId, result]));
  const key = evaluationKey(repo);

  if (!options.force && !options.practiceId && preloadedHead.sha !== null) {
    practices = practices.filter((practice) => {
      const previous = previousById.get(practice.id);

      // Settings and branch protections can change without a Git commit.
      const mutable =
        practice.parsed.ok &&
        practice.parsed.practice.checks.some(
          (check) =>
            check.type === "setting" ||
            check.type === "branch-protection" ||
            check.type === "ci-required-checks",
        );

      return (
        mutable ||
        !practice.parsed.ok ||
        !previous ||
        previous.headSha !== preloadedHead.sha ||
        previous.catalogSha !== catalog.sha ||
        previous.evaluationKey !== key ||
        !previous.cell.checkedAt ||
        previous.cell.state === "unknown" ||
        previous.cell.unknown > 0 ||
        Boolean(previous.cell.retrying)
      );
    });
  }

  if (practices.length === 0) {
    await deleteResultsNotIn(
      env.DB,
      fullName,
      catalog.practices.map((practice) => practice.id),
      guard,
    );

    return "skipped";
  }

  const validPractices = practices.flatMap((practice) =>
    practice.parsed.ok ? [practice.parsed.practice] : [],
  );

  const cache = preloadedHead.sha
    ? new GitHubSnapshotCache(env.DB, repo, preloadedHead.sha, options.force)
    : undefined;

  const snapshot = await takeSnapshot(client, repo, validPractices, preloadedHead, cache);

  const rows = practices.map((practice) => ({
    ...evaluatePractice(fullName, practice, snapshot, catalog.sha),
    evaluationKey: key,
  }));

  await writeResults(env.DB, rows, guard);
  await deleteResultsNotIn(
    env.DB,
    fullName,
    catalog.practices.map((practice) => practice.id),
    guard,
  );

  if (retryAfterSeconds !== undefined) {
    return new EvaluationCooldown(retryAfterSeconds);
  }

  return retryableReadFailure && rows.some((row) => row.cell.unknown > 0 && row.checks.length > 0)
    ? "retry"
    : "evaluated";
}
