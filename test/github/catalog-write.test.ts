/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-unknown-parameters, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion, oxforge/no-inline-types, typescript/no-unsafe-assignment, typescript/no-base-to-string, eslint/require-await, eslint/no-unsafe-optional-chaining, vitest/require-to-throw-message */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "@/env";
import {
  assertCatalogWrite,
  CatalogWriteRefusedError,
  commitCatalogChange,
} from "@/github/catalog-write";
import { TEST_PRIVATE_KEY_PEM } from "@test/helpers/app-key";
import { memoryKv } from "@test/helpers/oauth-state";

const catalogRepo = "aranlucas/practices";
const baseSha = "b".repeat(40);
const baseTreeSha = "t".repeat(40);
const nextTreeSha = "n".repeat(40);
const nextCommitSha = "c".repeat(40);

function jsonResponse(url: URL, body: unknown, status = 200): Response {
  const response = Response.json(body, { status });
  Object.defineProperty(response, "url", { value: url.toString() });
  return response;
}

function repository() {
  return {
    fullName: catalogRepo,
    owner: "aranlucas",
    name: "practices",
    installationId: 1,
    private: true,
    archived: false,
    fork: false,
    language: "TypeScript",
    defaultBranch: "main",
    pushedAt: null,
    url: `https://github.com/${catalogRepo}`,
  };
}

function testEnv(): AppEnv {
  const row = repository();
  const db = {
    prepare() {
      return {
        bind() {
          return {
            first: async () => ({
              full_name: row.fullName,
              owner: row.owner,
              name: row.name,
              installation_id: row.installationId,
              private: row.private ? 1 : 0,
              archived: row.archived ? 1 : 0,
              fork: row.fork ? 1 : 0,
              language: row.language,
              default_branch: row.defaultBranch,
              pushed_at: row.pushedAt,
              html_url: row.url,
              synced_at: new Date().toISOString(),
            }),
          };
        },
      };
    },
  } as unknown as D1Database;

  return {
    // SAFETY: this unit test exercises only token caching; memoryKv implements the required KV methods.
    OAUTH_KV: memoryKv() as AppEnv["OAUTH_KV"],
    OAUTH_PROVIDER: {} as AppEnv["OAUTH_PROVIDER"],
    DB: db,
    EVALUATIONS: {} as Queue<never>,
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
    GITHUB_APP_CLIENT_ID: "synthetic-client",
    GITHUB_APP_CLIENT_SECRET: "synthetic-secret",
    GITHUB_WEBHOOK_SECRET: "synthetic-webhook-secret",
    OWNER_GITHUB_ID: "1001",
    CATALOG_REPO: catalogRepo,
    ALLOWED_INSTALLATION_ACCOUNTS: "aranlucas",
  };
}

function gitDataFetch(options: { includeNested?: boolean; truncated?: boolean } = {}) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    const body = request.method === "GET" ? null : JSON.parse(init?.body?.toString() ?? "null");

    requests.push({ method: request.method, path, body });

    if (request.method === "POST" && path === "/app/installations/1/access_tokens") {
      return Promise.resolve(
        jsonResponse(url, { token: "installation-token", expires_at: "2030-01-01T00:00:00Z" }),
      );
    }

    if (request.method === "GET" && path === "/repos/aranlucas/practices") {
      return Promise.resolve(jsonResponse(url, { default_branch: "main" }));
    }

    if (request.method === "GET" && path === "/repos/aranlucas/practices/git/ref/heads/main") {
      return Promise.resolve(jsonResponse(url, { object: { sha: baseSha, type: "commit" } }));
    }

    if (request.method === "GET" && path === `/repos/aranlucas/practices/git/commits/${baseSha}`) {
      return Promise.resolve(jsonResponse(url, { tree: { sha: baseTreeSha } }));
    }

    if (
      request.method === "GET" &&
      path === `/repos/aranlucas/practices/git/trees/${baseTreeSha}`
    ) {
      return Promise.resolve(
        jsonResponse(url, {
          truncated: options.truncated ?? false,
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
            ...(options.includeNested
              ? [
                  {
                    path: "practices/husky/files",
                    mode: "040000",
                    type: "tree",
                    sha: "old-files-tree",
                  },
                  {
                    path: "practices/husky/files/nested",
                    mode: "040000",
                    type: "tree",
                    sha: "old-nested-tree",
                  },
                  {
                    path: "practices/husky/files/nested/old-file",
                    mode: "100644",
                    type: "blob",
                    sha: "old-nested-file",
                  },
                ]
              : []),
            {
              path: "practices/other/practice.yml",
              mode: "100644",
              type: "blob",
              sha: "other-yaml",
            },
          ],
        }),
      );
    }

    if (request.method === "POST" && path === "/repos/aranlucas/practices/git/blobs") {
      return Promise.resolve(jsonResponse(url, { sha: `blob-${requests.length}` }));
    }

    if (request.method === "POST" && path === "/repos/aranlucas/practices/git/trees") {
      return Promise.resolve(jsonResponse(url, { sha: nextTreeSha }));
    }

    if (request.method === "POST" && path === "/repos/aranlucas/practices/git/commits") {
      return Promise.resolve(jsonResponse(url, { sha: nextCommitSha }));
    }

    if (request.method === "PATCH" && path === "/repos/aranlucas/practices/git/refs/heads/main") {
      return Promise.resolve(jsonResponse(url, { object: { sha: nextCommitSha } }));
    }

    return Promise.resolve(
      jsonResponse(url, { message: `Unexpected ${request.method} ${path}` }, 404),
    );
  });

  return { fetchMock, requests };
}

describe("catalog write allowlist and Git Data commits", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["aranlucas/practices", "ARANLUCAS/Practices"])(
    "allows the configured catalog repository (%s)",
    (repo) => {
      expect(() =>
        assertCatalogWrite({ CATALOG_REPO: repo }, "aranlucas", "practices"),
      ).not.toThrow();
    },
  );

  it("allows a custom configured catalog repository case-insensitively", () => {
    expect(() =>
      assertCatalogWrite({ CATALOG_REPO: "ACME/PracticeCatalog" }, "acme", "practicecatalog"),
    ).not.toThrow();
  });

  it.each([
    ["aranlucas/shipshape-mcp", "aranlucas", "shipshape-mcp"],
    ["sidequest-labs/practices", "sidequest-labs", "practices"],
  ])("refuses writes outside the configured catalog (%s)", (candidate, owner, repo) => {
    expect(candidate).not.toBe(catalogRepo);
    expect(() => assertCatalogWrite({ CATALOG_REPO: catalogRepo }, owner, repo)).toThrow(
      CatalogWriteRefusedError,
    );
  });

  it("commits an update through Git Data in order and never forces the ref", async () => {
    const appEnv = testEnv();
    const { fetchMock, requests } = gitDataFetch();
    vi.stubGlobal("fetch", fetchMock);

    const sha = await commitCatalogChange(appEnv, {
      practiceId: "husky",
      yaml: "version: 1\nid: husky\n",
      instructions: "Use the hook.",
      files: [{ path: "pre-commit", content: "#!/bin/sh\n" }],
    });

    expect(sha).toBe(nextCommitSha);
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /app/installations/1/access_tokens",
      "GET /repos/aranlucas/practices",
      "GET /repos/aranlucas/practices/git/ref/heads/main",
      `GET /repos/aranlucas/practices/git/commits/${baseSha}`,
      `GET /repos/aranlucas/practices/git/trees/${baseTreeSha}`,
      "POST /repos/aranlucas/practices/git/blobs",
      "POST /repos/aranlucas/practices/git/blobs",
      "POST /repos/aranlucas/practices/git/blobs",
      "POST /repos/aranlucas/practices/git/trees",
      "POST /repos/aranlucas/practices/git/commits",
      "PATCH /repos/aranlucas/practices/git/refs/heads/main",
    ]);

    const tree = requests.find(
      ({ method, path }) => method === "POST" && path.endsWith("/git/trees"),
    );
    expect(tree?.body).toMatchObject({ base_tree: baseTreeSha });
    expect((tree?.body as { tree?: unknown[] }).tree).toContainEqual(
      expect.objectContaining({
        path: "practices/husky/files/pre-commit",
        type: "blob",
        mode: "100644",
      }),
    );
    const commit = requests.find(
      ({ method, path }) => method === "POST" && path.endsWith("/git/commits"),
    );
    expect(commit?.body).toMatchObject({
      message: "practice(husky): update from dashboard",
      tree: nextTreeSha,
    });
    const ref = requests.find(
      ({ method, path }) => method === "PATCH" && path.endsWith("/git/refs/heads/main"),
    );
    expect(ref?.body).toEqual({ sha: nextCommitSha, force: false });
  }, 15_000);

  it("deletes every existing path in only the practice folder", async () => {
    const appEnv = testEnv();
    const { fetchMock, requests } = gitDataFetch({ includeNested: true });
    vi.stubGlobal("fetch", fetchMock);

    await commitCatalogChange(appEnv, { practiceId: "husky", delete: true });

    const tree = requests.find(
      ({ method, path }) => method === "POST" && path.endsWith("/git/trees"),
    );
    const entries =
      (tree?.body as { tree?: Array<{ path: string; sha: string | null }> }).tree ?? [];
    expect(entries.map(({ path, sha }) => ({ path, sha }))).toEqual([
      { path: "practices/husky/practice.yml", sha: null },
      { path: "practices/husky/instructions.md", sha: null },
      { path: "practices/husky/files/pre-commit", sha: null },
      { path: "practices/husky/files/nested/old-file", sha: null },
    ]);
    expect(entries.some(({ path }) => path.startsWith("practices/other/"))).toBe(false);
    const commit = requests.find(
      ({ method, path }) => method === "POST" && path.endsWith("/git/commits"),
    );
    expect(commit?.body).toMatchObject({ message: "practice(husky): delete from dashboard" });
    const ref = requests.find(
      ({ method, path }) => method === "PATCH" && path.endsWith("/git/refs/heads/main"),
    );
    expect(ref?.body).toMatchObject({ force: false });
  }, 15_000);

  it("preserves omitted files through the base tree", async () => {
    const appEnv = testEnv();
    const { fetchMock, requests } = gitDataFetch();
    vi.stubGlobal("fetch", fetchMock);

    await commitCatalogChange(appEnv, {
      practiceId: "husky",
      yaml: "version: 1\nid: husky\n",
    });

    const tree = requests.find(
      ({ method, path }) => method === "POST" && path.endsWith("/git/trees"),
    );
    const entries =
      (tree?.body as { tree?: Array<{ path: string; sha: string | null }> }).tree ?? [];
    expect(entries).toEqual([
      expect.objectContaining({ path: "practices/husky/practice.yml", sha: expect.any(String) }),
    ]);
  }, 15_000);

  it("cleans up replaced nested files without emitting directory entries", async () => {
    const appEnv = testEnv();
    const { fetchMock, requests } = gitDataFetch({ includeNested: true });
    vi.stubGlobal("fetch", fetchMock);

    await commitCatalogChange(appEnv, {
      practiceId: "husky",
      files: [{ path: "new-file", content: "new\n" }],
    });

    const tree = requests.find(
      ({ method, path }) => method === "POST" && path.endsWith("/git/trees"),
    );
    const entries =
      (
        tree?.body as {
          tree?: Array<{ path: string; mode?: string; type?: string; sha: string | null }>;
        }
      ).tree ?? [];
    expect(entries.filter(({ sha }) => sha === null)).toEqual([
      {
        path: "practices/husky/files/pre-commit",
        mode: "100755",
        type: "blob",
        sha: null,
      },
      {
        path: "practices/husky/files/nested/old-file",
        mode: "100644",
        type: "blob",
        sha: null,
      },
    ]);
    expect(entries.some(({ type }) => type === "tree")).toBe(false);
    expect(entries).toContainEqual(
      expect.objectContaining({
        path: "practices/husky/files/new-file",
        mode: "100644",
        type: "blob",
      }),
    );
  }, 15_000);

  it("rejects a truncated recursive base tree before creating any Git Data objects", async () => {
    const appEnv = testEnv();
    const { fetchMock, requests } = gitDataFetch({ truncated: true });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      commitCatalogChange(appEnv, {
        practiceId: "husky",
        yaml: "version: 1\nid: husky\n",
      }),
    ).rejects.toThrow("Catalog tree is truncated");
    expect(
      requests.filter(
        ({ method, path }) =>
          (method === "POST" && path.includes("/git/")) ||
          (method === "PATCH" && path.includes("/git/refs/")),
      ),
    ).toEqual([]);
  }, 15_000);

  it("rejects unsafe catalog file paths before making a GitHub request", async () => {
    const appEnv = testEnv();
    const { fetchMock } = gitDataFetch();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      commitCatalogChange(appEnv, {
        practiceId: "husky",
        files: [{ path: "../outside", content: "nope" }],
      }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
