import type {
  CellResult,
  OverviewResponse,
  PracticeDetailResponse,
  RepoDetailResponse,
  RepoSummary,
} from "../api/contract";
import type { AppEnv } from "../env";
import { practiceSummary, readStoredCatalog } from "./catalog";
import {
  listRepositories,
  readCatalogRow,
  readResults,
  type StoredRepository,
  type StoredResult,
} from "./store";

type SweepRow = { last_completed_at: string | null; pending: number };

function defaultCell(): CellResult {
  return { state: "unknown", checkedAt: null, failing: 0, unknown: 0 };
}

export function repoSummary(repo: StoredRepository): RepoSummary {
  return {
    fullName: repo.fullName,
    owner: repo.owner,
    name: repo.name,
    private: repo.private,
    archived: repo.archived,
    fork: repo.fork,
    language: repo.language,
    defaultBranch: repo.defaultBranch,
    pushedAt: repo.pushedAt,
    url: repo.url,
  };
}

export async function buildOverview(env: AppEnv): Promise<OverviewResponse> {
  const [catalog, row, repos, results, sweep] = await Promise.all([
    readStoredCatalog(env.DB),
    readCatalogRow(env.DB),
    listRepositories(env.DB),
    readResults(env.DB),
    env.DB.prepare("SELECT last_completed_at, pending FROM sweep WHERE id = 1").first<SweepRow>(),
  ]);

  const resultMap: Record<string, Record<string, CellResult>> = {};

  for (const result of results) {
    (resultMap[result.repo] ??= {})[result.practiceId] = result.cell;
  }

  return {
    // Before the first catalog load (a fresh install), the overview is empty, not an error.
    catalog: {
      repo: catalog?.repo ?? env.CATALOG_REPO,
      sha: catalog?.sha ?? null,
      loadedAt: catalog ? (row?.loaded_at ?? null) : null,
    },
    practices: (catalog?.practices ?? [])
      .toSorted((left, right) => left.id.localeCompare(right.id))
      .map(practiceSummary),
    repos: repos
      .toSorted((left, right) => left.fullName.localeCompare(right.fullName))
      .map(repoSummary),
    results: resultMap,
    sweep: {
      lastCompletedAt: sweep?.last_completed_at ?? null,
      pending: sweep?.pending ?? 0,
    },
  };
}

function resultFor(results: StoredResult[], practiceId: string): StoredResult | undefined {
  return results.find((result) => result.practiceId === practiceId);
}

export async function buildRepoDetail(
  env: AppEnv,
  repo: StoredRepository,
): Promise<RepoDetailResponse> {
  const catalog = await readStoredCatalog(env.DB);
  const results = await readResults(env.DB, repo.fullName);
  const latestHeadSha = results.find((result) => result.headSha !== null)?.headSha ?? null;

  return {
    repo: repoSummary(repo),
    headSha: latestHeadSha,
    practices: (catalog?.practices ?? [])
      .toSorted((left, right) => left.id.localeCompare(right.id))
      .map((practice) => {
        const result = resultFor(results, practice.id);

        return {
          practice: practiceSummary(practice),
          result: result?.cell ?? defaultCell(),
          checks: result?.checks ?? [],
        };
      }),
  };
}

export class PracticeNotFoundError extends Error {
  constructor() {
    super("Practice not found");
  }
}

export async function buildPracticeDetail(
  env: AppEnv,
  practiceId: string,
): Promise<PracticeDetailResponse> {
  const catalog = await readStoredCatalog(env.DB);
  const practice = catalog?.practices.find((candidate) => candidate.id === practiceId);

  if (!practice) {
    throw new PracticeNotFoundError();
  }

  const [repos, results] = await Promise.all([listRepositories(env.DB), readResults(env.DB)]);

  const counts: PracticeDetailResponse["counts"] = {
    pass: 0,
    fail: 0,
    unknown: 0,
    not_applicable: 0,
  };

  for (const repo of repos) {
    const result = results.find(
      (candidate) => candidate.repo === repo.fullName && candidate.practiceId === practiceId,
    );

    counts[result?.cell.state ?? "unknown"] += 1;
  }

  const files = Object.entries(practice.files)
    .filter(([path]) => path.startsWith("files/"))
    .map(([path, content]) => ({ path: path.slice("files/".length), content }))
    .toSorted((left, right) => left.path.localeCompare(right.path));

  return {
    practice: practiceSummary(practice),
    yaml: practice.yaml,
    instructions: practice.instructions,
    files,
    counts,
  };
}
