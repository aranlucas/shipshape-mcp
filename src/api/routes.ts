/* oxlint-disable anti-slop/require-readable-spacing */

import { z } from "zod";

import type {
  ApiErrorResponse,
  CellResult,
  OverviewResponse,
  PracticeDetailResponse,
  RepoDetailResponse,
  RepoSummary,
} from "./contract";
import type { AppEnv } from "../env";
import { callbackUrl } from "../oauth";
import { CatalogWriteRefusedError, commitCatalogChange } from "../github/catalog-write";
import { RepositoryCoordinatesSchema } from "../github/schemas";
import { enqueueRepositories } from "../queue";
import {
  loadCatalog,
  practiceSummary,
  readStoredCatalog,
  type Catalog,
  type CatalogPractice,
} from "../practices/catalog";
import { parsePractice, RepoPath } from "../practices/schema";
import {
  getRepository,
  listRepositories,
  readCatalogRow,
  readResults,
  type StoredRepository,
  type StoredResult,
} from "../practices/store";
import type { WebSession } from "../web/session";

const IdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
  .max(64);
const SavePracticeSchema = z
  .object({
    yaml: z.string(),
    instructions: z.string().nullable().optional(),
    files: z.array(z.object({ path: z.string(), content: z.string() }).strict()).optional(),
  })
  .strict();
const RefreshRepositorySchema = z
  .string()
  .regex(/^[^/]+\/[^/]+$/u, "Enter a repository as owner/name")
  .refine((value) => {
    const [owner, repo] = value.split("/");

    return RepositoryCoordinatesSchema.safeParse({ owner, repo }).success;
  }, "Enter a valid repository as owner/name");
const RefreshSchema = z.object({ repo: RefreshRepositorySchema.optional() }).strict();

type ApiContext = ExecutionContext;
type ApiIssue = NonNullable<ApiErrorResponse["issues"]>[number];
type SweepRow = { last_completed_at: string | null; pending: number };
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type ApiResponseBody =
  | ApiErrorResponse
  | OverviewResponse
  | RepoDetailResponse
  | PracticeDetailResponse
  | { catalogSha: string }
  | { queued: number };

function json(body: ApiResponseBody, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function errorResponse(error: string, status: number, issues?: ApiIssue[]) {
  const body: ApiErrorResponse = issues === undefined ? { error } : { error, issues };

  return json(body, status);
}

function sameOrigin(request: Request, env: AppEnv): boolean {
  const expected = callbackUrl(request, env, "/").origin;
  const site = request.headers.get("Sec-Fetch-Site");

  return request.headers.get("Origin") === expected && (site === null || site === "same-origin");
}

function isJsonRequest(request: Request): boolean {
  return (
    request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json"
  );
}

async function readJson(request: Request): Promise<JsonObject> {
  try {
    return z.record(z.string(), z.json()).parse(JSON.parse(await request.text()));
  } catch {
    throw new ResponseError("Invalid JSON body", 400);
  }
}

function defaultCell(): CellResult {
  return { state: "unknown", checkedAt: null, failing: 0, unknown: 0 };
}

function repoSummary(repo: StoredRepository): RepoSummary {
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

function storedCatalogOrThrow(catalog: Catalog | null): Catalog {
  if (!catalog) {
    throw new Error("Practice catalog is unavailable");
  }

  return catalog;
}

async function buildOverview(env: AppEnv): Promise<OverviewResponse> {
  const [catalog, row, repos, results, sweep] = await Promise.all([
    readStoredCatalog(env.DB),
    readCatalogRow(env.DB),
    listRepositories(env.DB),
    readResults(env.DB),
    env.DB.prepare("SELECT last_completed_at, pending FROM sweep WHERE id = 1").first<SweepRow>(),
  ]);
  const loaded = storedCatalogOrThrow(catalog);
  const resultMap: Record<string, Record<string, CellResult>> = {};

  for (const result of results) {
    (resultMap[result.repo] ??= {})[result.practiceId] = result.cell;
  }

  return {
    catalog: {
      repo: loaded.repo,
      sha: loaded.sha,
      loadedAt: row?.loaded_at ?? null,
    },
    practices: loaded.practices
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

async function buildRepoDetail(env: AppEnv, repo: StoredRepository): Promise<RepoDetailResponse> {
  const catalog = storedCatalogOrThrow(await readStoredCatalog(env.DB));
  const results = await readResults(env.DB, repo.fullName);
  const latestHeadSha = results.find((result) => result.headSha !== null)?.headSha ?? null;

  return {
    repo: repoSummary(repo),
    headSha: latestHeadSha,
    practices: catalog.practices
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

async function buildPracticeDetail(
  env: AppEnv,
  practiceId: string,
): Promise<PracticeDetailResponse> {
  const catalog = storedCatalogOrThrow(await readStoredCatalog(env.DB));
  const practice = catalog.practices.find((candidate) => candidate.id === practiceId);

  if (!practice) {
    throw new ResponseError("Practice not found", 404);
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

class ResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function isKnownPractice(catalog: Catalog, id: string): CatalogPractice | undefined {
  return catalog.practices.find((practice) => practice.id === id);
}

async function handleSave(env: AppEnv, request: Request, practiceId: string): Promise<Response> {
  const body = SavePracticeSchema.parse(await readJson(request));
  const parsed = parsePractice(body.yaml, practiceId);

  if (!parsed.ok) {
    return errorResponse("Practice is invalid", 400, parsed.issues);
  }

  if (body.files !== undefined) {
    const seen = new Set<string>();

    for (const file of body.files) {
      const normalizedPath = `files/${file.path}`;

      if (!RepoPath.safeParse(file.path).success || seen.has(normalizedPath)) {
        return errorResponse("Practice is invalid", 400, [
          { path: "files", message: "Every file path must be unique and repository-relative" },
        ]);
      }

      seen.add(normalizedPath);
    }
  }

  const catalogSha = await commitCatalogChange(env, {
    practiceId,
    yaml: body.yaml,
    instructions: body.instructions,
    files: body.files,
  });
  await loadCatalog(env);

  return json({ catalogSha }, 200);
}

async function handleDelete(env: AppEnv, practiceId: string): Promise<Response> {
  const catalog = storedCatalogOrThrow(await readStoredCatalog(env.DB));

  if (!isKnownPractice(catalog, practiceId)) {
    throw new ResponseError("Practice not found", 404);
  }

  const catalogSha = await commitCatalogChange(env, { practiceId, delete: true });
  await loadCatalog(env);

  return json({ catalogSha }, 200);
}

async function handleRefresh(env: AppEnv, request: Request): Promise<Response> {
  const body = RefreshSchema.parse(await readJson(request));
  const repos =
    body.repo !== undefined
      ? [await getRepository(env.DB, body.repo)].filter(
          (repo): repo is StoredRepository => repo !== null,
        )
      : await listRepositories(env.DB);

  if (body.repo && repos.length === 0) {
    throw new ResponseError("Repository not found", 404);
  }

  return json({ queued: await enqueueRepositories(env, repos, "manual") }, 202);
}

function safeFailure(error: Error): Response {
  if (error instanceof ResponseError) {
    return errorResponse(error.message, error.status);
  }

  if (error instanceof z.ZodError) {
    return errorResponse(
      "Invalid request",
      400,
      error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }

  if (error instanceof CatalogWriteRefusedError) {
    return errorResponse("Catalog write refused", 403);
  }

  return errorResponse("Dashboard API unavailable", 500);
}

export async function apiHandler(
  request: Request,
  env: AppEnv,
  _session: WebSession,
  _ctx: ApiContext,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const endpoint = parts.slice(2);

    if (request.method !== "GET") {
      if (!sameOrigin(request, env)) {
        return errorResponse("Cross-origin request refused.", 403);
      }

      if (!isJsonRequest(request)) {
        return errorResponse("JSON body required", 400);
      }
    }

    if (request.method === "GET" && endpoint.length === 1 && endpoint[0] === "overview") {
      return json(await buildOverview(env));
    }

    if (request.method === "GET" && endpoint[0] === "repos" && endpoint.length === 3) {
      const owner = decodeURIComponent(endpoint[1] ?? "");
      const name = decodeURIComponent(endpoint[2] ?? "");
      const repo = await getRepository(env.DB, `${owner}/${name}`);

      if (!repo) {
        return errorResponse("Repository not found", 404);
      }

      return json(await buildRepoDetail(env, repo));
    }

    if (request.method === "GET" && endpoint[0] === "practices" && endpoint.length === 2) {
      const practiceId = endpoint[1] ?? "";
      IdSchema.parse(practiceId);

      return json(await buildPracticeDetail(env, practiceId));
    }

    if (
      (request.method === "PUT" || request.method === "DELETE") &&
      endpoint[0] === "practices" &&
      endpoint.length === 2
    ) {
      const practiceId = endpoint[1] ?? "";
      IdSchema.parse(practiceId);

      return request.method === "PUT"
        ? await handleSave(env, request, practiceId)
        : await handleDelete(env, practiceId);
    }

    if (request.method === "POST" && endpoint.length === 1 && endpoint[0] === "refresh") {
      return await handleRefresh(env, request);
    }

    return errorResponse("Not found", 404);
  } catch (error) {
    return safeFailure(error instanceof Error ? error : new Error("Dashboard API unavailable"));
  }
}
