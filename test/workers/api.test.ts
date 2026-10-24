import { parseJson } from "@test/helpers/json";
import { queueSendResponse } from "@test/helpers/queue";
import {
  GitDataRequestBodySchema,
  gitTreeEntries,
  type RecordedGitRequest,
} from "@test/helpers/git-data";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv, EvaluationMessage } from "@/env";
import worker from "@/index";
import { createSession, SESSION_COOKIE_NAME } from "@/web/session";
import { BUILT_IN_SOURCES } from "@test/helpers/no-built-in-sources";
import { parsePractice } from "@/practices/schema";
import {
  listRepositories,
  upsertRepositories,
  writeCatalog,
  writeResults,
  type StoredRepository,
} from "@/practices/store";
import {
  ApiErrorResponseSchema,
  CatalogWriteResponseSchema,
  OverviewResponseSchema,
  PracticeDetailResponseSchema,
  RefreshResponseSchema,
  RepoDetailResponseSchema,
} from "@test/helpers/contract-schemas";

// SAFETY: cloudflare:test supplies the configured Worker bindings used by the API.
const appEnv = env as AppEnv;

const ORIGIN = "https://shipshape-mcp.aranlucas.workers.dev";

const catalogSha = "a".repeat(40);

const nextCatalogSha = "c".repeat(40);

const validYaml = `version: 1
id: husky
title: Husky hooks
summary: Keep hooks configured
kind: files
checks:
  - type: file-exists
    path: .husky/pre-commit
`;

const invalidYaml = `version: 1
id: husky
title: Husky hooks
summary: Keep hooks configured
kind: files
checks:
  - type: file-exist
    path: .husky/pre-commit
`;

const brokenYaml = `version: 1
id: broken
title: Broken
summary: Invalid check
kind: files
checks:
  - type: file-exist
    path: README.md
`;

function repository(fullName: string, installationId = 1): StoredRepository {
  const [owner = "owner", name = "repo"] = fullName.split("/");

  return {
    fullName,
    owner,
    name,
    installationId,
    private: fullName.endsWith("/private"),
    archived: false,
    fork: false,
    language: "TypeScript",
    defaultBranch: "main",
    pushedAt: "2026-10-15T12:00:00.000Z",
    url: `https://github.com/${fullName}`,
  };
}

function practice(id: string, yaml: string, files: Record<string, string> = {}) {
  const parsed = parsePractice(yaml, id);

  return {
    id,
    folder: id,
    yaml,
    instructions: id === "husky" ? "Install the hook." : null,
    files,
    parsed,
  };
}

async function seed() {
  await appEnv.DB.batch([
    appEnv.DB.prepare("DELETE FROM results"),
    appEnv.DB.prepare("DELETE FROM catalog"),
    appEnv.DB.prepare("DELETE FROM repositories"),
    appEnv.DB.prepare("UPDATE sweep SET pending = 0, last_completed_at = NULL WHERE id = 1"),
  ]);

  await upsertRepositories(
    appEnv.DB,
    [
      repository("aranlucas/zeta"),
      repository("aranlucas/alpha"),
      repository("aranlucas/practices"),
    ],
    new Date().toISOString(),
  );
  await writeCatalog(
    appEnv.DB,
    {
      repo: "aranlucas/practices",
      sha: catalogSha,
      practices: [
        practice("husky", validYaml, { "files/pre-commit": "#!/bin/sh\n" }),
        practice("broken", brokenYaml),
      ],
    },
    "2026-10-15T12:00:00.000Z",
  );
  await writeResults(appEnv.DB, [
    {
      repo: "aranlucas/alpha",
      practiceId: "husky",
      cell: {
        state: "fail",
        checkedAt: "2026-10-15T12:30:00.000Z",
        failing: 1,
        unknown: 0,
      },
      checks: [
        {
          type: "file-exists",
          label: "File exists",
          state: "fail",
          path: ".husky/pre-commit",
          expected: "present",
          actual: "missing",
          detail: null,
        },
      ],
      headSha: "h".repeat(40),
      catalogSha,
    },
    {
      repo: "aranlucas/zeta",
      practiceId: "broken",
      cell: { state: "unknown", checkedAt: null, failing: 0, unknown: 1 },
      checks: [],
      headSha: null,
      catalogSha,
    },
  ]);
}

async function request(
  path: string,
  init: RequestInit = {},
  authenticated = true,
  requestEnv: AppEnv = appEnv,
): Promise<Response> {
  const headers = new Headers(init.headers);

  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  if (authenticated) {
    const secret = await createSession(appEnv.OAUTH_KV, { login: "aranlucas", userId: 1001 });
    headers.set("cookie", `${SESSION_COOKIE_NAME}=${secret}`);
  }

  const ctx = createExecutionContext();

  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, { ...init, headers }),
    requestEnv,
    ctx,
  );

  await waitOnExecutionContext(ctx);

  return response;
}

function evaluationRequests(messages: Iterable<MessageSendRequest<EvaluationMessage>> = []) {
  return [...messages].map(({ body, ...options }) => {
    expect(body.jobId).toBeTypeOf("string");
    const { jobId: _jobId, ...evaluation } = body;

    return { ...options, body: evaluation };
  });
}

function gitDataFetch() {
  const requests: RecordedGitRequest[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const outboundRequest = new Request(input, init);
    const url = new URL(outboundRequest.url);
    const path = decodeURIComponent(url.pathname);

    const body =
      outboundRequest.body === null
        ? null
        : GitDataRequestBodySchema.parse(await outboundRequest.json());

    requests.push({ method: outboundRequest.method, path, body });

    if (outboundRequest.method === "GET" && path === "/app/installations") {
      return Response.json([{ id: 1, account: { login: "aranlucas", type: "User" } }]);
    }

    if (outboundRequest.method === "GET" && path === "/installation/repositories") {
      const response = Response.json({
        total_count: 2,
        repositories: ["private", "practices"].map((name, index) => ({
          id: index + 1,
          name,
          full_name: `aranlucas/${name}`,
          private: true,
          html_url: `https://github.com/aranlucas/${name}`,
          default_branch: "main",
          archived: false,
          fork: false,
          language: "TypeScript",
          pushed_at: "2026-10-15T12:00:00Z",
        })),
      });

      Object.defineProperty(response, "url", { value: outboundRequest.url });

      return response;
    }

    if (outboundRequest.method === "POST" && path === "/app/installations/1/access_tokens") {
      return Response.json({ token: "installation-token", expires_at: "2030-01-01T00:00:00Z" });
    }

    if (outboundRequest.method === "GET" && path === "/repos/aranlucas/practices") {
      return Response.json({ default_branch: "main" });
    }

    if (
      outboundRequest.method === "GET" &&
      path === "/repos/aranlucas/practices/git/ref/heads/main"
    ) {
      return Response.json({ object: { sha: "b".repeat(40), type: "commit" } });
    }

    if (
      outboundRequest.method === "GET" &&
      path === `/repos/aranlucas/practices/git/commits/${"b".repeat(40)}`
    ) {
      return Response.json({ tree: { sha: "t".repeat(40) } });
    }

    if (
      outboundRequest.method === "GET" &&
      path === `/repos/aranlucas/practices/git/trees/${"t".repeat(40)}`
    ) {
      return Response.json({
        truncated: false,
        tree: [
          { path: "practices/husky/practice.yml", mode: "100644", type: "blob", sha: "old-yaml" },
          {
            path: "practices/husky/instructions.md",
            mode: "100644",
            type: "blob",
            sha: "old-instructions",
          },
          {
            path: "practices/husky/files/pre-commit",
            mode: "100755",
            type: "blob",
            sha: "old-file",
          },
        ],
      });
    }

    if (outboundRequest.method === "POST" && path === "/repos/aranlucas/practices/git/blobs") {
      return Response.json({ sha: `blob-${requests.length}` });
    }

    if (outboundRequest.method === "POST" && path === "/repos/aranlucas/practices/git/trees") {
      return Response.json({ sha: "n".repeat(40) });
    }

    if (outboundRequest.method === "POST" && path === "/repos/aranlucas/practices/git/commits") {
      return Response.json({ sha: nextCatalogSha });
    }

    if (
      outboundRequest.method === "PATCH" &&
      path === "/repos/aranlucas/practices/git/refs/heads/main"
    ) {
      return Response.json({ object: { sha: nextCatalogSha } });
    }

    if (outboundRequest.method === "GET" && path === "/repos/aranlucas/practices/commits/main") {
      return Response.json({ sha: nextCatalogSha });
    }

    if (
      outboundRequest.method === "GET" &&
      path === `/repos/aranlucas/practices/git/trees/${nextCatalogSha}`
    ) {
      return Response.json({
        truncated: false,
        tree: [
          {
            path: "practices/husky/practice.yml",
            mode: "100644",
            type: "blob",
            sha: "new-yaml",
            size: validYaml.length,
          },
          {
            path: "practices/husky/instructions.md",
            mode: "100644",
            type: "blob",
            sha: "new-instructions",
            size: 18,
          },
          {
            path: "practices/husky/files/pre-commit",
            mode: "100755",
            type: "blob",
            sha: "new-file",
            size: 10,
          },
        ],
      });
    }

    const blobs = new Map([
      ["new-yaml", validYaml],
      ["new-instructions", "Install the hook."],
      ["new-file", "#!/bin/sh\n"],
    ]);

    if (outboundRequest.method === "GET" && path.includes("/git/blobs/")) {
      const sha = path.split("/").at(-1) ?? "";
      const content = blobs.get(sha) ?? "";

      return Response.json({ content: btoa(content), encoding: "base64", size: content.length });
    }

    return Response.json(
      { message: `Unexpected ${outboundRequest.method} ${path}` },
      { status: 404 },
    );
  });

  return { fetchMock, requests };
}

describe("dashboard API", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await seed();
    await appEnv.OAUTH_KV.delete("app:installation-token:1");
  });

  it("returns a strict overview contract with sorted practices/repos and retained validation errors", async () => {
    const response = await request("/app/api/overview");
    expect(response.status).toBe(200);
    const body = OverviewResponseSchema.parse(await parseJson(response));
    expect(body.catalog).toEqual({
      repo: "aranlucas/practices",
      sha: catalogSha,
      loadedAt: "2026-10-15T12:00:00.000Z",
      disabled: [],
    });
    expect(body.practices.map(({ id }) => id)).toEqual(["broken", "husky"]);
    const broken = body.practices.find(({ id }) => id === "broken");
    expect(broken?.valid).toBe(false);
    expect(broken?.error).toContain("checks.0.type");
    expect(body.repos.map(({ fullName }) => fullName)).toEqual([
      "aranlucas/alpha",
      "aranlucas/practices",
      "aranlucas/zeta",
    ]);
    expect(body.results["aranlucas/alpha"]?.husky).toMatchObject({ state: "fail", failing: 1 });
    expect(body.results["aranlucas/zeta"]?.broken).toMatchObject({ state: "unknown", unknown: 1 });
  });

  it("returns an empty overview on a fresh install, before any catalog or inventory loads", async () => {
    await appEnv.DB.batch([
      appEnv.DB.prepare("DELETE FROM results"),
      appEnv.DB.prepare("DELETE FROM repositories"),
      appEnv.DB.prepare("DELETE FROM catalog"),
    ]);

    const response = await request("/app/api/overview");
    expect(response.status).toBe(200);
    const body = OverviewResponseSchema.parse(await parseJson(response));
    expect(body.catalog).toEqual({
      repo: "aranlucas/practices",
      sha: null,
      loadedAt: null,
      disabled: [],
    });
    expect(body.practices).toEqual([]);
    expect(body.repos).toEqual([]);
    expect(body.results).toEqual({});
  });

  it("returns repository detail with no practices before the catalog loads", async () => {
    await appEnv.DB.prepare("DELETE FROM catalog").run();

    const detail = await request("/app/api/repos/aranlucas/alpha");
    expect(detail.status).toBe(200);
    const body = RepoDetailResponseSchema.parse(await parseJson(detail));
    expect(body.repo.fullName).toBe("aranlucas/alpha");
    expect(body.practices).toEqual([]);
    expect(body.catalog).toEqual({ sha: null, loadedAt: null });
  });

  it("does not present results from a previous catalog revision as current evidence", async () => {
    await appEnv.DB.prepare("UPDATE results SET catalog_sha = ?").bind("d".repeat(40)).run();

    const overview = OverviewResponseSchema.parse(
      await parseJson(await request("/app/api/overview")),
    );

    expect(overview.results).toEqual({});

    const practiceDetail = PracticeDetailResponseSchema.parse(
      await parseJson(await request("/app/api/practices/husky")),
    );

    expect(practiceDetail.counts.pass).toBe(0);
    expect(practiceDetail.counts.fail).toBe(0);

    const detail = RepoDetailResponseSchema.parse(
      await parseJson(await request("/app/api/repos/aranlucas/alpha")),
    );

    expect(detail.practices.every((entry) => entry.result.checkedAt === null)).toBe(true);
    expect(
      detail.practices.every((entry) => entry.checks.length === 0 && entry.headSha === null),
    ).toBe(true);
  });

  it("returns repository detail and a contract 404 for an unknown repository", async () => {
    const detail = await request("/app/api/repos/aranlucas/alpha");
    expect(detail.status).toBe(200);
    const body = RepoDetailResponseSchema.parse(await parseJson(detail));
    expect(body.repo.fullName).toBe("aranlucas/alpha");
    expect(body.catalog.sha).toBe(catalogSha);
    expect(body.practices.find((entry) => entry.practice.id === "husky")).toMatchObject({
      headSha: "h".repeat(40),
      catalogSha,
    });
    expect(body.practices.map(({ practice: summary }) => summary.id)).toEqual(["broken", "husky"]);

    const missing = await request("/app/api/repos/aranlucas/missing");
    expect(missing.status).toBe(404);
    expect(ApiErrorResponseSchema.parse(await parseJson(missing))).toEqual({
      error: "Repository not found",
    });
  });

  it("returns practice detail with all state counts, including zero values", async () => {
    const response = await request("/app/api/practices/husky");
    expect(response.status).toBe(200);
    const body = PracticeDetailResponseSchema.parse(await parseJson(response));
    expect(body.files).toEqual([{ path: "pre-commit", content: "#!/bin/sh\n" }]);
    expect(body.counts).toEqual({ pass: 0, fail: 1, unknown: 2, not_applicable: 0 });
  });

  it("rejects invalid YAML at checks.0.type without making a GitHub write", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await request("/app/api/practices/husky", {
      method: "PUT",
      headers: { origin: ORIGIN },
      body: JSON.stringify({ yaml: invalidYaml }),
    });

    expect(response.status).toBe(400);
    const body = ApiErrorResponseSchema.parse(await parseJson(response));
    expect(body.error).toBe("Practice is invalid");
    expect(body.issues?.[0]?.path).toBe("checks.0.type");
    expect(fetchMock.mock.calls).toEqual([]);
  });

  it("rejects unsafe files paths before a GitHub write", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await request("/app/api/practices/husky", {
      method: "PUT",
      headers: { origin: ORIGIN },
      body: JSON.stringify({ yaml: validYaml, files: [{ path: "../outside", content: "nope" }] }),
    });

    expect(response.status).toBe(400);
    expect(fetchMock.mock.calls).toEqual([]);
  });

  it("commits a valid PUT, uses Git Data in sequence, and reloads the stored catalog", async () => {
    const { fetchMock, requests } = gitDataFetch();
    vi.stubGlobal("fetch", fetchMock);

    const response = await request("/app/api/practices/husky", {
      method: "PUT",
      headers: { origin: ORIGIN },
      body: JSON.stringify({
        yaml: validYaml,
        instructions: "Install the hook.",
        files: [{ path: "pre-commit", content: "#!/bin/sh\n" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(CatalogWriteResponseSchema.parse(await parseJson(response))).toEqual({
      catalogSha: nextCatalogSha,
    });

    const writeMethods = requests
      .filter(({ method }) => ["POST", "PATCH"].includes(method))
      .map(({ method, path }) => `${method} ${path}`);

    expect(writeMethods).toEqual([
      "POST /app/installations/1/access_tokens",
      "POST /repos/aranlucas/practices/git/blobs",
      "POST /repos/aranlucas/practices/git/blobs",
      "POST /repos/aranlucas/practices/git/blobs",
      "POST /repos/aranlucas/practices/git/trees",
      "POST /repos/aranlucas/practices/git/commits",
      "PATCH /repos/aranlucas/practices/git/refs/heads/main",
    ]);
    expect(
      requests.find(
        ({ method, path }) => method === "PATCH" && path.endsWith("/git/refs/heads/main"),
      )?.body,
    ).toMatchObject({ force: false });

    const overview = await request("/app/api/overview");
    expect(OverviewResponseSchema.parse(await parseJson(overview)).catalog.sha).toBe(
      nextCatalogSha,
    );
    expect(
      requests.some(({ method, path }) => method === "GET" && path.endsWith("/commits/main")),
    ).toBe(true);
  });

  it("reads overview without loading detailed evidence", async () => {
    await appEnv.DB.prepare("UPDATE results SET checks_json = 'not JSON'").run();
    const response = await request("/app/api/overview");
    expect(response.status).toBe(200);
    expect(
      OverviewResponseSchema.parse(await parseJson(response)).results["aranlucas/alpha"].husky
        .state,
    ).toBe("fail");
  });

  it("blocks preview mutations while preserving owner read access", async () => {
    const previewEnv = { ...appEnv, PREVIEW_READ_ONLY: "true" };

    const response = await request(
      "/app/api/refresh",
      { method: "POST", body: "{}" },
      true,
      previewEnv,
    );

    expect(response.status).toBe(403);
    expect((await request("/app/api/overview", {}, true, previewEnv)).status).toBe(200);
    expect(
      await appEnv.DB.prepare("SELECT COUNT(*) AS count FROM evaluation_jobs").first(),
    ).toEqual({ count: 0 });
  });

  it("queues every repository for re-evaluation after a saved catalog change", async () => {
    const { fetchMock } = gitDataFetch();
    vi.stubGlobal("fetch", fetchMock);

    const sendBatch = vi
      .spyOn(appEnv.EVALUATIONS, "sendBatch")
      .mockResolvedValue(queueSendResponse);

    const repos = await listRepositories(appEnv.DB);

    const response = await request("/app/api/practices/husky", {
      method: "PUT",
      headers: { origin: ORIGIN },
      body: JSON.stringify({ yaml: validYaml }),
    });

    expect(response.status).toBe(200);
    expect(repos.length).toBeGreaterThan(0);
    expect(evaluationRequests(sendBatch.mock.calls[0]?.[0])).toEqual(
      repos.map((repo) => ({
        body: {
          repo: repo.fullName,
          installationId: repo.installationId,
          reason: "catalog",
        },
      })),
    );
  });

  it("prepends the catalog files directory to repository-relative file paths", async () => {
    const { fetchMock, requests } = gitDataFetch();
    vi.stubGlobal("fetch", fetchMock);

    const response = await request("/app/api/practices/husky", {
      method: "PUT",
      headers: { origin: ORIGIN },
      body: JSON.stringify({
        yaml: validYaml,
        files: [{ path: "files/foo.txt", content: "nested\n" }],
      }),
    });

    expect(response.status).toBe(200);

    const tree = requests.find(
      ({ method, path }) => method === "POST" && path.endsWith("/git/trees"),
    );

    const treeBody = { tree: gitTreeEntries(tree) };
    expect(treeBody?.tree ?? []).toContainEqual(
      expect.objectContaining({
        path: "practices/husky/files/files/foo.txt",
        mode: "100644",
        type: "blob",
      }),
    );
  });

  it("round-trips practice detail file paths through save", async () => {
    const detail = PracticeDetailResponseSchema.parse(
      await parseJson(await request("/app/api/practices/husky")),
    );

    expect(detail.files).toEqual([{ path: "pre-commit", content: "#!/bin/sh\n" }]);

    const { fetchMock, requests } = gitDataFetch();
    vi.stubGlobal("fetch", fetchMock);

    const response = await request("/app/api/practices/husky", {
      method: "PUT",
      headers: { origin: ORIGIN },
      body: JSON.stringify({ yaml: detail.yaml, files: detail.files }),
    });

    expect(response.status).toBe(200);

    const tree = requests.find(
      ({ method, path }) => method === "POST" && path.endsWith("/git/trees"),
    );

    const treeBody = { tree: gitTreeEntries(tree) };
    expect(treeBody?.tree ?? []).toContainEqual(
      expect.objectContaining({
        path: "practices/husky/files/pre-commit",
        mode: "100644",
        type: "blob",
      }),
    );
  });

  it.each(["text/plain", ""])(
    "accepts valid JSON without a JSON content type (%s)",
    async (contentType) => {
      const sendBatch = vi
        .spyOn(appEnv.EVALUATIONS, "sendBatch")
        .mockResolvedValue(queueSendResponse);

      const response = await request("/app/api/refresh", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": contentType },
        body: JSON.stringify({ repo: "aranlucas/alpha" }),
      });

      expect(response.status).toBe(202);
      expect(RefreshResponseSchema.parse(await parseJson(response))).toEqual({ queued: 1 });
      expect(evaluationRequests(sendBatch.mock.calls[0]?.[0])).toEqual([
        {
          body: {
            repo: "aranlucas/alpha",
            installationId: 1,
            reason: "manual",
          },
        },
      ]);
    },
  );

  it("allows DELETE without a body or content type and returns 404 for an unknown practice", async () => {
    const response = await request("/app/api/practices/unknown", {
      method: "DELETE",
      headers: { origin: ORIGIN },
    });

    expect(response.status).toBe(404);
    expect(ApiErrorResponseSchema.parse(await parseJson(response)).error).toBeTypeOf("string");
  });

  it("discovers installed private repositories and loads the catalog on the first refresh", async () => {
    await appEnv.DB.batch([
      appEnv.DB.prepare("DELETE FROM results"),
      appEnv.DB.prepare("DELETE FROM repositories"),
      appEnv.DB.prepare("DELETE FROM catalog"),
    ]);
    const { fetchMock } = gitDataFetch();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    const sendBatch = vi
      .spyOn(appEnv.EVALUATIONS, "sendBatch")
      .mockResolvedValue(queueSendResponse);

    const response = await request("/app/api/refresh", {
      method: "POST",
      headers: { origin: ORIGIN },
      body: "{}",
    });

    expect(response.status).toBe(202);
    expect(RefreshResponseSchema.parse(await parseJson(response))).toEqual({ queued: 2 });

    const overview = OverviewResponseSchema.parse(
      await parseJson(await request("/app/api/overview")),
    );

    expect(
      overview.repos.map(({ fullName, private: isPrivate }) => ({ fullName, isPrivate })),
    ).toEqual([
      { fullName: "aranlucas/practices", isPrivate: true },
      { fullName: "aranlucas/private", isPrivate: true },
    ]);
    expect(overview.practices.map(({ id }) => id)).toEqual(["husky"]);
    expect(evaluationRequests(sendBatch.mock.calls[0]?.[0])).toEqual(
      expect.arrayContaining([
        {
          body: {
            repo: "aranlucas/private",
            installationId: 1,
            reason: "manual",
          },
        },
      ]),
    );
  });

  it("refreshes one known repository with the manual reason", async () => {
    const sendBatch = vi
      .spyOn(appEnv.EVALUATIONS, "sendBatch")
      .mockResolvedValue(queueSendResponse);

    const response = await request("/app/api/refresh", {
      method: "POST",
      body: JSON.stringify({ repo: "aranlucas/alpha" }),
    });

    expect(response.status).toBe(202);
    expect(RefreshResponseSchema.parse(await parseJson(response))).toEqual({ queued: 1 });
    expect(evaluationRequests(sendBatch.mock.calls[0]?.[0])).toEqual([
      {
        body: {
          repo: "aranlucas/alpha",
          installationId: 1,
          reason: "manual",
        },
      },
    ]);
  });

  it("returns 404 when refreshing an unknown repository", async () => {
    const sendBatch = vi
      .spyOn(appEnv.EVALUATIONS, "sendBatch")
      .mockResolvedValue(queueSendResponse);

    const response = await request("/app/api/refresh", {
      method: "POST",
      headers: { origin: ORIGIN },
      body: JSON.stringify({ repo: "aranlucas/missing" }),
    });

    expect(response.status).toBe(404);
    expect(ApiErrorResponseSchema.parse(await parseJson(response)).error).toBeTypeOf("string");
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it.each(["", "malformed", "aranlucas/alpha/extra"])(
    "rejects an invalid explicit repository filter (%s) without queueing",
    async (repo) => {
      const sendBatch = vi
        .spyOn(appEnv.EVALUATIONS, "sendBatch")
        .mockResolvedValue(queueSendResponse);

      const response = await request("/app/api/refresh", {
        method: "POST",
        headers: { origin: ORIGIN },
        body: JSON.stringify({ repo }),
      });

      expect(response.status).toBe(400);
      expect(ApiErrorResponseSchema.parse(await parseJson(response)).error).toBeTypeOf("string");
      expect(sendBatch).not.toHaveBeenCalled();
    },
  );

  it.each(["/app/api/overview/", "/app/api//overview", "/app/api//overview//"])(
    "rejects noncanonical route paths (%s)",
    async (path) => {
      const response = await request(path);

      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(ApiErrorResponseSchema.parse(await parseJson(response))).toEqual({
        error: "Not found",
      });
    },
  );

  it("decodes repository route parameters", async () => {
    const response = await request("/app/api/repos/%61ranlucas/%61lpha");

    expect(response.status).toBe(200);
    expect(RepoDetailResponseSchema.parse(await parseJson(response)).repo.fullName).toBe(
      "aranlucas/alpha",
    );
  });

  it.each(["GET", "PUT", "DELETE"])("validates practice IDs for %s requests", async (method) => {
    const response = await request("/app/api/practices/INVALID", {
      method,
      headers: { origin: ORIGIN, "content-type": "application/json" },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const failure = ApiErrorResponseSchema.parse(await parseJson(response));
    expect(failure.error).toBe("Invalid request");
    expect(failure.issues).toBeInstanceOf(Array);
  });

  it.each(["{", "[]", "null"])("rejects an invalid JSON object body (%s)", async (body) => {
    const response = await request("/app/api/refresh", {
      method: "POST",
      headers: { origin: ORIGIN },
      body,
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(ApiErrorResponseSchema.parse(await parseJson(response))).toEqual({
      error: "Invalid JSON body",
    });
  });

  it.each(["PATCH", "OPTIONS"])(
    "returns a JSON 404 for unsupported %s requests",
    async (method) => {
      const response = await request("/app/api/overview", { method });

      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(ApiErrorResponseSchema.parse(await parseJson(response))).toEqual({
        error: "Not found",
      });
    },
  );

  it("serves HEAD requests through GET without requiring write headers", async () => {
    const response = await request("/app/api/overview", { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("returns a safe JSON response for unexpected handler failures", async () => {
    vi.spyOn(appEnv.DB, "prepare").mockImplementation(() => {
      throw new Error("Private database failure");
    });

    const response = await request("/app/api/repos/aranlucas/alpha");

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(ApiErrorResponseSchema.parse(await parseJson(response))).toEqual({
      error: "Dashboard API unavailable",
    });
  });

  it("returns 401 for an unauthenticated API request", async () => {
    const response = await request("/app/api/overview", {}, false);
    expect(response.status).toBe(401);
    expect(ApiErrorResponseSchema.parse(await parseJson(response)).error).toBeTypeOf("string");
  });
});

function treeEntries(requests: RecordedGitRequest[]) {
  const tree = requests.find(
    ({ method, path }) => method === "POST" && path.endsWith("/git/trees"),
  );

  return gitTreeEntries(tree).map(({ path, sha }) => ({ path, sha }));
}

function commitMessage(requests: RecordedGitRequest[]) {
  const commit = requests.find(
    ({ method, path }) => method === "POST" && path.endsWith("/git/commits"),
  );

  return commit?.body?.message;
}

describe("built-in practices", () => {
  const lintYaml = validYaml.replace("id: husky", "id: lint").replace("Husky hooks", "Lint");

  beforeEach(async () => {
    vi.restoreAllMocks();
    await seed();
    await appEnv.OAUTH_KV.delete("app:installation-token:1");
    // husky matches the catalog's copy exactly; lint exists only as a built-in.
    Object.assign(BUILT_IN_SOURCES, {
      "practices/husky/practice.yml": validYaml,
      "practices/husky/instructions.md": "Install the hook.",
      "practices/husky/files/pre-commit": "#!/bin/sh\n",
      "practices/lint/practice.yml": lintYaml,
    });
  });

  afterEach(() => {
    for (const key of Object.keys(BUILT_IN_SOURCES)) {
      delete BUILT_IN_SOURCES[key];
    }
  });

  it("layers the catalog repository over built-ins", async () => {
    vi.spyOn(appEnv.EVALUATIONS, "sendBatch").mockResolvedValue(queueSendResponse);

    const body = OverviewResponseSchema.parse(await parseJson(await request("/app/api/overview")));

    expect(
      body.practices.map(({ id, origin, matchesBuiltIn }) => ({ id, origin, matchesBuiltIn })),
    ).toEqual([
      { id: "broken", origin: "custom", matchesBuiltIn: false },
      { id: "husky", origin: "override", matchesBuiltIn: true },
      { id: "lint", origin: "built-in", matchesBuiltIn: false },
    ]);
    expect(body.catalog.sha).toMatch(new RegExp(`^${catalogSha}\\+[0-9a-f]{8}$`, "u"));
  });

  it("requeues every repository once when a deploy changes the built-ins", async () => {
    const sendBatch = vi
      .spyOn(appEnv.EVALUATIONS, "sendBatch")
      .mockResolvedValue(queueSendResponse);

    await request("/app/api/overview");
    await request("/app/api/overview");

    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(evaluationRequests(sendBatch.mock.calls[0]?.[0])).toEqual(
      (await listRepositories(appEnv.DB)).map((repo) => ({
        body: {
          repo: repo.fullName,
          installationId: repo.installationId,
          reason: "catalog",
        },
      })),
    );
  });

  it.each([
    ["an override", "husky"],
    ["a built-in with no catalog folder", "lint"],
  ])("turns off %s with a disabled marker instead of deleting it", async (_case, id) => {
    vi.spyOn(appEnv.EVALUATIONS, "sendBatch").mockResolvedValue(queueSendResponse);
    const { fetchMock, requests } = gitDataFetch();
    vi.stubGlobal("fetch", fetchMock);

    const response = await request(`/app/api/practices/${id}`, {
      method: "DELETE",
      headers: { origin: ORIGIN },
      body: "{}",
    });

    expect(response.status).toBe(200);
    const marker = treeEntries(requests).find(({ path }) => path === `practices/${id}/disabled`);
    expect(marker?.sha).toMatch(/^blob-/u);
    expect(commitMessage(requests)).toBe(`practice(${id}): turn off built-in from dashboard`);
  });

  it("deletes a custom practice outright", async () => {
    vi.spyOn(appEnv.EVALUATIONS, "sendBatch").mockResolvedValue(queueSendResponse);
    const { fetchMock, requests } = gitDataFetch();
    vi.stubGlobal("fetch", fetchMock);

    const response = await request("/app/api/practices/broken", {
      method: "DELETE",
      headers: { origin: ORIGIN },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(commitMessage(requests)).toBe("practice(broken): delete from dashboard");
  });

  it("resets an override by deleting its catalog folder without a marker", async () => {
    vi.spyOn(appEnv.EVALUATIONS, "sendBatch").mockResolvedValue(queueSendResponse);
    const { fetchMock, requests } = gitDataFetch();
    vi.stubGlobal("fetch", fetchMock);

    const response = await request("/app/api/practices/husky/reset", {
      method: "POST",
      headers: { origin: ORIGIN },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(treeEntries(requests)).toEqual([
      { path: "practices/husky/practice.yml", sha: null },
      { path: "practices/husky/instructions.md", sha: null },
      { path: "practices/husky/files/pre-commit", sha: null },
    ]);
  });

  it.each(["broken", "lint"])(
    "refuses to reset %s, which has no catalog copy of a built-in",
    async (id) => {
      const response = await request(`/app/api/practices/${id}/reset`, {
        method: "POST",
        headers: { origin: ORIGIN },
        body: "{}",
      });

      expect(response.status).toBe(404);
    },
  );
});
