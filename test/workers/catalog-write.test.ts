import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "@/env";
import {
  assertCatalogWrite,
  CatalogWriteRefusedError,
  commitCatalogChange,
} from "@/github/catalog-write";
import { upsertRepositories } from "@/practices/store";
import type { JsonValue } from "@test/helpers/json";
import {
  GitDataRequestBodySchema,
  gitTreeEntries,
  type RecordedGitRequest,
} from "@test/helpers/git-data";

const catalogRepo = "aranlucas/practices";

const baseSha = "b".repeat(40);

const baseTreeSha = "t".repeat(40);

const nextTreeSha = "n".repeat(40);

const nextCommitSha = "c".repeat(40);

function jsonResponse(url: URL, body: JsonValue, status = 200): Response {
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
  return env;
}

beforeEach(async () => {
  await upsertRepositories(env.DB, [repository()], new Date().toISOString());
  await env.OAUTH_KV.delete("app:installation-token:1");
});

interface GitDataOptions {
  includeNested?: boolean;
  includeDisabled?: boolean;
  truncated?: boolean;
}

function gitDataFetch(options: GitDataOptions = {}) {
  const requests: RecordedGitRequest[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);

    const body =
      request.body === null ? null : GitDataRequestBodySchema.parse(await request.json());

    requests.push({ method: request.method, path, body });

    if (request.method === "POST" && path === "/app/installations/1/access_tokens") {
      return jsonResponse(url, { token: "installation-token", expires_at: "2030-01-01T00:00:00Z" });
    }

    if (request.method === "GET" && path === "/repos/aranlucas/practices") {
      return jsonResponse(url, { default_branch: "main" });
    }

    if (request.method === "GET" && path === "/repos/aranlucas/practices/git/ref/heads/main") {
      return jsonResponse(url, { object: { sha: baseSha, type: "commit" } });
    }

    if (request.method === "GET" && path === `/repos/aranlucas/practices/git/commits/${baseSha}`) {
      return jsonResponse(url, { tree: { sha: baseTreeSha } });
    }

    if (
      request.method === "GET" &&
      path === `/repos/aranlucas/practices/git/trees/${baseTreeSha}`
    ) {
      return jsonResponse(url, {
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
          ...(options.includeDisabled
            ? [
                {
                  path: "practices/husky/disabled",
                  mode: "100644",
                  type: "blob",
                  sha: "old-marker",
                },
              ]
            : []),
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
      });
    }

    if (request.method === "POST" && path === "/repos/aranlucas/practices/git/blobs") {
      return jsonResponse(url, { sha: `blob-${requests.length}` });
    }

    if (request.method === "POST" && path === "/repos/aranlucas/practices/git/trees") {
      return jsonResponse(url, { sha: nextTreeSha });
    }

    if (request.method === "POST" && path === "/repos/aranlucas/practices/git/commits") {
      return jsonResponse(url, { sha: nextCommitSha });
    }

    if (request.method === "PATCH" && path === "/repos/aranlucas/practices/git/refs/heads/main") {
      return jsonResponse(url, { object: { sha: nextCommitSha } });
    }

    return jsonResponse(url, { message: `Unexpected ${request.method} ${path}` }, 404);
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
    expect(gitTreeEntries(tree)).toContainEqual(
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

    const entries = gitTreeEntries(tree);

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

  it("turns off a built-in by replacing its folder with a disabled marker", async () => {
    const appEnv = testEnv();
    const { fetchMock, requests } = gitDataFetch({ includeDisabled: true });
    vi.stubGlobal("fetch", fetchMock);

    await commitCatalogChange(appEnv, { practiceId: "husky", delete: true, disable: true });

    const tree = requests.find(
      ({ method, path }) => method === "POST" && path.endsWith("/git/trees"),
    );

    const entries = gitTreeEntries(tree);

    const marker = entries.find(({ path }) => path === "practices/husky/disabled");
    expect(marker?.sha).toMatch(/^blob-/u);
    expect(entries.map(({ path, sha }) => ({ path, sha }))).toEqual([
      { path: "practices/husky/practice.yml", sha: null },
      { path: "practices/husky/instructions.md", sha: null },
      { path: "practices/husky/files/pre-commit", sha: null },
      { path: "practices/husky/disabled", sha: marker?.sha },
    ]);

    const commit = requests.find(
      ({ method, path }) => method === "POST" && path.endsWith("/git/commits"),
    );

    expect(commit?.body).toMatchObject({
      message: "practice(husky): turn off built-in from dashboard",
    });
  }, 15_000);

  it("removes a disabled marker when the practice is saved", async () => {
    const appEnv = testEnv();
    const { fetchMock, requests } = gitDataFetch({ includeDisabled: true });
    vi.stubGlobal("fetch", fetchMock);

    await commitCatalogChange(appEnv, { practiceId: "husky", yaml: "version: 1\nid: husky\n" });

    const tree = requests.find(
      ({ method, path }) => method === "POST" && path.endsWith("/git/trees"),
    );

    expect(gitTreeEntries(tree)).toContainEqual(
      expect.objectContaining({ path: "practices/husky/disabled", sha: null }),
    );
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

    const entries = gitTreeEntries(tree);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe("practices/husky/practice.yml");
    expect(entries[0]?.sha).toMatch(/^blob-/u);
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

    const entries = gitTreeEntries(tree);

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
    ).rejects.toThrow(/path/iu);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
