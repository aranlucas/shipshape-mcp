/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-readable-spacing, typescript/no-unsafe-assignment */

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CellResult } from "@/api/contract";
import type { AppEnv } from "@/env";
import { evaluateRepository } from "@/practices/evaluate";
import { type Catalog, type CatalogPractice, readStoredCatalog } from "@/practices/catalog";
import {
  type StoredRepository,
  type StoredResult,
  readResults,
  upsertRepositories,
  writeCatalog,
  writeResults,
} from "@/practices/store";
import { parsePractice, type Practice } from "@/practices/schema";

// SAFETY: cloudflare:test supplies the Worker bindings configured in vitest.config.ts.
const appEnv = env as AppEnv;
const repoName = "octo/demo";
const headSha = "b".repeat(40);
const catalogSha = "a".repeat(40);
const nextCatalogSha = "d".repeat(40);
const oldCheckedAt = "2026-10-01T12:00:00.000Z";

const repository: StoredRepository = {
  fullName: repoName,
  owner: "octo",
  name: "demo",
  installationId: 42,
  private: false,
  archived: false,
  fork: false,
  language: "TypeScript",
  defaultBranch: "main",
  pushedAt: "2026-10-01T00:00:00.000Z",
  url: "https://github.com/octo/demo",
};

function validPractice(
  id: string,
  kind: Practice["kind"],
  checks: Practice["checks"],
  appliesTo: Partial<Practice["appliesTo"]> = {},
): CatalogPractice {
  const practice: Practice = {
    version: 1,
    id,
    title: id,
    summary: `Practice ${id}`,
    kind,
    appliesTo: {
      include: ["*"],
      exclude: [],
      archived: false,
      forks: false,
      ...appliesTo,
    },
    checks,
  };

  return {
    id,
    folder: id,
    yaml: "",
    instructions: null,
    files: {},
    parsed: { ok: true, practice },
  };
}

function invalidPractice(id: string): CatalogPractice {
  const yaml = `version: 1\nid: ${id}\ntitle: Broken\nsummary: Broken\nkind: files\nchecks: []\n`;

  return {
    id,
    folder: id,
    yaml,
    instructions: null,
    files: {},
    parsed: parsePractice(yaml, id),
  };
}

function catalog(practices: CatalogPractice[], sha = catalogSha): Catalog {
  return { repo: "aranlucas/practices", sha, practices };
}

function cell(
  state: CellResult["state"],
  checkedAt: string | null = null,
  failing = 0,
  unknown = 0,
): CellResult {
  return { state, checkedAt, failing, unknown };
}

function storedRow(
  practiceId: string,
  state: CellResult["state"] = "pass",
  checkedAt: string | null = oldCheckedAt,
): StoredResult {
  return {
    repo: repoName,
    practiceId,
    cell: cell(state, checkedAt),
    checks: [],
    headSha,
    catalogSha,
  };
}

async function seed(catalogValue: Catalog, rows: StoredResult[] = []): Promise<void> {
  await upsertRepositories(appEnv.DB, [repository], new Date().toISOString());
  await writeCatalog(appEnv.DB, catalogValue, new Date().toISOString());

  if (rows.length > 0) {
    await writeResults(appEnv.DB, rows);
  }
}

function jsonResponse(value: unknown, status = 200, url?: string): Response {
  const response = new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

  if (url) {
    Object.defineProperty(response, "url", { value: url });
  }

  return response;
}

interface FetchCall {
  method: string;
  path: string;
}

interface GitHubMockOptions {
  tokenStatus?: number;
  headStatus?: number;
  treeStatus?: number;
  treePaths?: string[];
  settings?: Record<string, unknown>;
  head?: string;
}

function mockGitHub(options: GitHubMockOptions = {}): FetchCall[] {
  const calls: FetchCall[] = [];
  const currentHead = options.head ?? headSha;

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      calls.push({ method: request.method, path: url.pathname });

      if (request.method === "POST" && url.pathname === "/app/installations/42/access_tokens") {
        if (options.tokenStatus && options.tokenStatus !== 200) {
          return Promise.resolve(
            jsonResponse({ message: "token exchange failed" }, options.tokenStatus),
          );
        }

        return Promise.resolve(
          jsonResponse(
            {
              token: "installation-token",
              expires_at: "2030-01-01T00:00:00Z",
            },
            201,
          ),
        );
      }

      if (url.pathname === `/repos/octo/demo/commits/main`) {
        if (options.headStatus && options.headStatus !== 200) {
          return Promise.resolve(
            jsonResponse({ message: "Git Repository is empty" }, options.headStatus),
          );
        }

        return Promise.resolve(jsonResponse({ sha: currentHead }));
      }

      if (url.pathname === `/repos/octo/demo/git/trees/${currentHead}`) {
        if (options.treeStatus && options.treeStatus !== 200) {
          return Promise.resolve(
            jsonResponse({ message: "Git Repository is empty" }, options.treeStatus),
          );
        }

        return Promise.resolve(
          jsonResponse({
            truncated: false,
            tree: (options.treePaths ?? ["README.md"]).map((path) => ({
              path,
              mode: "100644",
              type: "blob",
              sha: "e".repeat(40),
              size: 1,
            })),
          }),
        );
      }

      if (url.pathname === "/repos/octo/demo") {
        return Promise.resolve(jsonResponse({ allow_squash_merge: true, ...options.settings }));
      }

      if (url.pathname.startsWith("/repos/octo/demo/contents/")) {
        return Promise.resolve(
          jsonResponse({ type: "file", encoding: "base64", content: btoa("content"), size: 7 }),
        );
      }

      return Promise.resolve(jsonResponse({ message: `Unhandled ${url.pathname}` }, 404));
    }),
  );

  return calls;
}

beforeEach(async () => {
  await env.OAUTH_KV.delete("app:installation-token:42");
  await appEnv.DB.batch([
    appEnv.DB.prepare("DELETE FROM results"),
    appEnv.DB.prepare("DELETE FROM catalog"),
    appEnv.DB.prepare("DELETE FROM repositories"),
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("evaluateRepository", () => {
  it("evaluates passing, failing, and language-inapplicable practices into D1", async () => {
    const practices = [
      validPractice("readme", "files", [{ type: "file-exists", path: "README.md", absent: false }]),
      validPractice("missing", "files", [
        { type: "file-exists", path: "missing.md", absent: false },
      ]),
      validPractice(
        "python-only",
        "files",
        [{ type: "file-exists", path: "README.md", absent: false }],
        { languages: ["Python"] },
      ),
    ];
    await seed(catalog(practices));
    mockGitHub({ treePaths: ["README.md"] });

    await expect(evaluateRepository(appEnv, repoName)).resolves.toBe("evaluated");

    const rows = await readResults(appEnv.DB, repoName);
    expect(rows).toHaveLength(3);
    const byId = new Map(rows.map((row) => [row.practiceId, row]));

    expect(byId.get("readme")?.cell).toMatchObject({
      state: "pass",
      failing: 0,
      unknown: 0,
    });
    expect(byId.get("missing")?.cell).toMatchObject({
      state: "fail",
      failing: 1,
      unknown: 0,
    });
    expect(byId.get("python-only")?.cell).toMatchObject({
      state: "not_applicable",
      failing: 0,
      unknown: 0,
    });
    expect(rows.every((row) => row.cell.checkedAt !== null)).toBe(true);
    expect(byId.get("missing")?.checks[0]?.state).toBe("fail");
  });

  it("skips unchanged evaluations after reading only the current head SHA", async () => {
    const practices = [
      validPractice("readme", "files", [{ type: "file-exists", path: "README.md", absent: false }]),
    ];
    await seed(catalog(practices));
    const calls = mockGitHub({ treePaths: ["README.md"] });
    await expect(evaluateRepository(appEnv, repoName)).resolves.toBe("evaluated");

    calls.length = 0;
    await expect(evaluateRepository(appEnv, repoName)).resolves.toBe("skipped");
    expect(calls).toEqual([{ method: "GET", path: "/repos/octo/demo/commits/main" }]);
  });

  it("re-evaluates when force is true even when head and catalog are unchanged", async () => {
    const practices = [
      validPractice("readme", "files", [{ type: "file-exists", path: "README.md", absent: false }]),
    ];
    await seed(catalog(practices));
    const calls = mockGitHub({ treePaths: ["README.md"] });
    await evaluateRepository(appEnv, repoName);

    calls.length = 0;
    await expect(evaluateRepository(appEnv, repoName, { force: true })).resolves.toBe("evaluated");
    expect(calls.some((call) => call.path === `/repos/octo/demo/git/trees/${headSha}`)).toBe(true);
  });

  it.each([404, 401, 500])(
    "marks existing results unknown and preserves checked_at for installation token HTTP %s",
    async (status) => {
      const practices = [
        validPractice("readme", "files", [
          { type: "file-exists", path: "README.md", absent: false },
        ]),
      ];
      await seed(catalog(practices), [storedRow("readme")]);
      mockGitHub({ tokenStatus: status });

      await expect(evaluateRepository(appEnv, repoName)).resolves.toBe("unavailable");

      const rows = await readResults(appEnv.DB, repoName);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.cell).toMatchObject({ state: "unknown", checkedAt: oldCheckedAt });
      expect(JSON.stringify(rows)).toContain("GitHub App installation unavailable");
    },
  );

  it("recovers after an unavailable installation even when head and catalog are unchanged", async () => {
    const practices = [
      validPractice("readme", "files", [{ type: "file-exists", path: "README.md", absent: false }]),
    ];
    await seed(catalog(practices), [storedRow("readme")]);
    mockGitHub({ tokenStatus: 404 });

    await expect(evaluateRepository(appEnv, repoName)).resolves.toBe("unavailable");
    expect((await readResults(appEnv.DB, repoName))[0]?.cell.checkedAt).toBe(oldCheckedAt);

    vi.unstubAllGlobals();
    const calls = mockGitHub({ treePaths: ["README.md"] });
    await expect(evaluateRepository(appEnv, repoName)).resolves.toBe("evaluated");
    expect(calls.some((call) => call.path === `/repos/octo/demo/git/trees/${headSha}`)).toBe(true);
  });

  it("keeps settings checks evaluable when an empty repository tree returns 409", async () => {
    const practices = [
      validPractice("file-practice", "files", [
        { type: "file-exists", path: "README.md", absent: false },
      ]),
      validPractice("settings-practice", "settings", [
        { type: "setting", key: "allow_squash_merge", equals: true },
      ]),
    ];
    await seed(catalog(practices));
    const calls = mockGitHub({ treeStatus: 409 });

    await expect(evaluateRepository(appEnv, repoName)).resolves.toBe("evaluated");
    const firstRows = await readResults(appEnv.DB, repoName);
    const firstById = new Map(firstRows.map((row) => [row.practiceId, row]));
    expect(firstById.get("file-practice")?.cell.state).toBe("unknown");
    expect(JSON.stringify(firstById.get("file-practice"))).toContain("Repository has no commits");
    expect(firstById.get("settings-practice")?.cell.state).toBe("pass");
    expect(calls.some((call) => call.path === "/repos/octo/demo")).toBe(true);
  });

  it("retries a tree failure even when the head and catalog remain unchanged", async () => {
    const practices = [
      validPractice("file-practice", "files", [
        { type: "file-exists", path: "README.md", absent: false },
      ]),
    ];
    await seed(catalog(practices));
    mockGitHub({ treeStatus: 409 });

    await expect(evaluateRepository(appEnv, repoName)).resolves.toBe("evaluated");

    vi.unstubAllGlobals();
    const calls = mockGitHub({ treePaths: ["README.md"] });
    await expect(evaluateRepository(appEnv, repoName)).resolves.toBe("evaluated");
    expect(calls.some((call) => call.path === `/repos/octo/demo/git/trees/${headSha}`)).toBe(true);
    expect((await readResults(appEnv.DB, repoName))[0]?.cell.state).toBe("pass");
  });

  it("does not skip a repeated evaluation when the repository head is unavailable", async () => {
    const practices = [
      validPractice("file-practice", "files", [
        { type: "file-exists", path: "README.md", absent: false },
      ]),
    ];
    await seed(catalog(practices));
    const calls = mockGitHub({ headStatus: 409 });

    await expect(evaluateRepository(appEnv, repoName)).resolves.toBe("evaluated");
    calls.length = 0;
    await expect(evaluateRepository(appEnv, repoName)).resolves.toBe("evaluated");
    expect(calls.filter((call) => call.path === "/repos/octo/demo/commits/main")).toHaveLength(1);
  });

  it("stores invalid practices as unknown while evaluating valid practices", async () => {
    const practices = [
      validPractice("readme", "files", [{ type: "file-exists", path: "README.md", absent: false }]),
      invalidPractice("broken"),
    ];
    await seed(catalog(practices));
    mockGitHub({ treePaths: ["README.md"] });

    await expect(evaluateRepository(appEnv, repoName)).resolves.toBe("evaluated");

    const rows = await readResults(appEnv.DB, repoName);
    const byId = new Map(rows.map((row) => [row.practiceId, row]));
    expect(byId.get("broken")?.cell.state).toBe("unknown");
    expect(byId.get("broken")?.checks).toEqual([]);
    expect(byId.get("readme")?.cell.state).toBe("pass");
    const stored = await readStoredCatalog(appEnv.DB);
    expect(stored?.practices.find((practice) => practice.id === "broken")?.parsed).toMatchObject({
      ok: false,
      issues: expect.any(Array),
    });
  });

  it("deletes stored result rows for practices removed from the catalog", async () => {
    const keep = validPractice("keep", "files", [
      { type: "file-exists", path: "README.md", absent: false },
    ]);
    const removed = validPractice("removed", "files", [
      { type: "file-exists", path: "README.md", absent: false },
    ]);
    await seed(catalog([keep, removed]), [storedRow("keep"), storedRow("removed")]);
    await writeCatalog(appEnv.DB, catalog([keep], nextCatalogSha), new Date().toISOString());
    mockGitHub({ treePaths: ["README.md"] });

    await expect(evaluateRepository(appEnv, repoName)).resolves.toBe("evaluated");

    expect((await readResults(appEnv.DB, repoName)).map((row) => row.practiceId)).toEqual(["keep"]);
  });
});
