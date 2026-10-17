/* oxlint-disable anti-slop/require-readable-spacing */

import { Hono } from "hono";
import { z } from "zod";

import type {
  ApiErrorResponse,
  OverviewResponse,
  PracticeDetailResponse,
  RepoDetailResponse,
} from "./contract";
import type { AppEnv } from "../env";
import { syncInventory } from "../inventory/sync";
import { callbackUrl } from "../oauth";
import { CatalogWriteRefusedError, commitCatalogChange } from "../github/catalog-write";
import { RepositoryCoordinatesSchema } from "../github/schemas";
import { enqueueRepositories, requeueIfBuiltInsChanged } from "../queue";
import {
  loadCatalog,
  readStoredCatalog,
  type Catalog,
  type CatalogPractice,
} from "../practices/catalog";
import {
  buildOverview,
  buildPracticeDetail,
  buildRepoDetail,
  PracticeNotFoundError,
} from "../practices/views";
import { parsePractice, RepoPath } from "../practices/schema";
import { getRepository, listRepositories, type StoredRepository } from "../practices/store";
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

interface ApiEnv {
  Bindings: AppEnv;
}
type ApiIssue = NonNullable<ApiErrorResponse["issues"]>[number];
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

async function readJson(request: Request): Promise<JsonObject> {
  try {
    return z.record(z.string(), z.json()).parse(JSON.parse(await request.text()));
  } catch {
    throw new ResponseError("Invalid JSON body", 400);
  }
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

// Results from an older catalog are hidden, so re-evaluate now instead of waiting for the push webhook.
async function reloadCatalogAndRequeue(env: AppEnv): Promise<void> {
  await loadCatalog(env);
  await enqueueRepositories(env, await listRepositories(env.DB), "catalog");
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
  await reloadCatalogAndRequeue(env);

  return json({ catalogSha }, 200);
}

async function handleDelete(env: AppEnv, practiceId: string): Promise<Response> {
  const catalog = await readStoredCatalog(env.DB);
  const practice = catalog ? isKnownPractice(catalog, practiceId) : undefined;

  if (!practice) {
    throw new ResponseError("Practice not found", 404);
  }

  // A built-in would reappear if its folder were only deleted, so leave a marker.
  const catalogSha = await commitCatalogChange(env, {
    practiceId,
    delete: true,
    disable: (practice.origin ?? "custom") !== "custom",
  });
  await reloadCatalogAndRequeue(env);

  return json({ catalogSha }, 200);
}

/** Removes the catalog folder of a built-in: undoes an override or turns it back on. */
async function handleReset(env: AppEnv, practiceId: string): Promise<Response> {
  const catalog = await readStoredCatalog(env.DB);

  const resettable =
    catalog !== null &&
    (catalog.practices.some(
      (practice) => practice.id === practiceId && practice.origin === "override",
    ) ||
      catalog.disabled.some((practice) => practice.id === practiceId));

  if (!resettable) {
    throw new ResponseError("No catalog copy of this built-in practice to remove", 404);
  }

  const catalogSha = await commitCatalogChange(env, { practiceId, delete: true });
  await reloadCatalogAndRequeue(env);

  return json({ catalogSha }, 200);
}

async function handleRefresh(env: AppEnv, request: Request): Promise<Response> {
  const body = RefreshSchema.parse(await readJson(request));
  let repos =
    body.repo !== undefined
      ? [await getRepository(env.DB, body.repo)].filter(
          (repo): repo is StoredRepository => repo !== null,
        )
      : await listRepositories(env.DB);

  if (body.repo === undefined && repos.length === 0) {
    repos = await syncInventory(env);
    if (repos.length === 0) {
      throw new ResponseError(
        "No repositories are accessible through the GitHub App. Check its installations.",
        409,
      );
    }
    await loadCatalog(env);
  }

  if (body.repo && repos.length === 0) {
    throw new ResponseError("Repository not found", 404);
  }

  return json({ queued: await enqueueRepositories(env, repos, "manual") }, 202);
}

function safeFailure(error: Error): Response {
  if (error instanceof ResponseError) {
    return errorResponse(error.message, error.status);
  }

  if (error instanceof PracticeNotFoundError) {
    return errorResponse(error.message, 404);
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

const api = new Hono<ApiEnv>().basePath("/app/api");

api.onError(safeFailure);
api.notFound(() => errorResponse("Not found", 404));

api.use("*", async (c, next) => {
  const request = c.req.raw;

  if (
    (request.method === "POST" || request.method === "PUT" || request.method === "DELETE") &&
    !sameOrigin(request, c.env)
  ) {
    return errorResponse("Cross-origin request refused.", 403);
  }

  await next();
});

api.get("/overview", async (c) => {
  await requeueIfBuiltInsChanged(c.env);

  return json(await buildOverview(c.env));
});

api.get("/repos/:owner/:name", async (c) => {
  const repo = await getRepository(c.env.DB, `${c.req.param("owner")}/${c.req.param("name")}`);

  if (!repo) {
    return errorResponse("Repository not found", 404);
  }

  return json(await buildRepoDetail(c.env, repo));
});

api.get("/practices/:practiceId", async (c) => {
  const practiceId = IdSchema.parse(c.req.param("practiceId"));

  return json(await buildPracticeDetail(c.env, practiceId));
});

api.put("/practices/:practiceId", (c) =>
  handleSave(c.env, c.req.raw, IdSchema.parse(c.req.param("practiceId"))),
);

api.delete("/practices/:practiceId", (c) =>
  handleDelete(c.env, IdSchema.parse(c.req.param("practiceId"))),
);

api.post("/practices/:practiceId/reset", (c) =>
  handleReset(c.env, IdSchema.parse(c.req.param("practiceId"))),
);

api.post("/refresh", (c) => handleRefresh(c.env, c.req.raw));

export async function apiHandler(
  request: Request,
  env: AppEnv,
  _session: WebSession,
  ctx: ExecutionContext,
): Promise<Response> {
  try {
    return await api.fetch(request, env, ctx);
  } catch (error) {
    // Hono's onError handles Error instances; keep non-Error throws behind the same safe response.
    return safeFailure(error instanceof Error ? error : new Error("Dashboard API unavailable"));
  }
}
