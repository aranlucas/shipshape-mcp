import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "@/env";
import { readCatalogRow, writeCatalog } from "@/practices/store";
import { parsePractice } from "@/practices/schema";
import {
  CatalogUnavailableError,
  loadCatalog,
  practiceSummary,
  readStoredCatalog,
} from "@/practices/catalog";

/* oxlint-disable anti-slop/require-readable-spacing */

// SAFETY: cloudflare:test supplies all runtime bindings used by the worker tests.
const appEnv = env as AppEnv;

const sha = "c0ffee0000000000000000000000000000000000";

const validYaml = `version: 1\nid: husky\ntitle: Husky\nsummary: Keep hooks\nkind: files\nchecks:\n  - type: file-exists\n    path: .husky/pre-commit\n`;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function response(url: URL, body: JsonValue, status = 200): Response {
  const result = Response.json(body, { status });
  Object.defineProperty(result, "url", { value: url.toString() });

  return result;
}

describe("practice catalog", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM catalog"),
      env.DB.prepare("DELETE FROM repositories"),
    ]);
  });

  it("loads, sorts, parses, and persists practices while ignoring README", async () => {
    await env.DB.prepare(
      `INSERT INTO repositories
       (full_name, owner, name, installation_id, private, archived, fork, language,
        default_branch, pushed_at, html_url, synced_at)
       VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "aranlucas/practices",
        "aranlucas",
        "practices",
        1,
        "TypeScript",
        "main",
        null,
        "https://github.com/aranlucas/practices",
        new Date().toISOString(),
      )
      .run();

    const blobs = {
      yml: validYaml,
      instructions: "Run pre-commit.",
      hook: "#!/bin/sh\n",
      broken: "version: 1\nid: broken\nchecks: []\n",
    };

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);

      if (request.method === "POST") {
        return Promise.resolve(
          response(url, { token: "installation-token-1", expires_at: "2030-01-01T00:00:00Z" }),
        );
      }

      if (url.pathname === "/repos/aranlucas/practices") {
        return Promise.resolve(response(url, { default_branch: "main" }));
      }

      if (url.pathname === "/repos/aranlucas/practices/commits/main") {
        return Promise.resolve(response(url, { sha }));
      }

      if (url.pathname.endsWith(`/git/trees/${sha}`)) {
        return Promise.resolve(
          response(url, {
            truncated: false,
            tree: [
              { path: "README.md", mode: "100644", type: "blob", sha: "readme", size: 4 },
              {
                path: "practices/husky/practice.yml",
                mode: "100644",
                type: "blob",
                sha: "yml",
                size: validYaml.length,
              },
              {
                path: "practices/husky/instructions.md",
                mode: "100644",
                type: "blob",
                sha: "instructions",
                size: 15,
              },
              {
                path: "practices/husky/files/.husky/pre-commit",
                mode: "100755",
                type: "blob",
                sha: "hook",
                size: 10,
              },
              {
                path: "practices/broken/practice.yml",
                mode: "100644",
                type: "blob",
                sha: "broken",
                size: 35,
              },
            ],
          }),
        );
      }

      const id = url.pathname.split("/").at(-1) ?? "";

      const blobContent =
        id === "yml"
          ? blobs.yml
          : id === "instructions"
            ? blobs.instructions
            : id === "hook"
              ? blobs.hook
              : blobs.broken;

      return Promise.resolve(
        response(url, {
          content: btoa(blobContent),
          encoding: "base64",
          size: blobContent.length,
        }),
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const catalog = await loadCatalog(appEnv);
    expect(catalog.practices.map((practice) => practice.id)).toEqual(["broken", "husky"]);
    const husky = catalog.practices[1];
    expect(husky?.instructions).toBe("Run pre-commit.");
    expect(husky?.files["files/.husky/pre-commit"]).toBe("#!/bin/sh\n");
    expect(catalog.practices[0]?.parsed.ok).toBe(false);
    const broken = catalog.practices[0];
    expect(broken).toBeDefined();

    if (!broken) {
      throw new Error("broken practice was not loaded");
    }

    expect(practiceSummary(broken)).toMatchObject({ valid: false });

    expect(await readStoredCatalog(env.DB)).toEqual(catalog);
    expect(
      fetchMock.mock.calls.some(([input]) => {
        const request = input instanceof Request ? input : new Request(input);

        return request.url.includes("README");
      }),
    ).toBe(false);
  });

  it("revalidates persisted YAML without changing source evidence or accepting invalid definitions", async () => {
    const presenceYaml = validYaml.replace(
      "type: file-exists\n    path: .husky/pre-commit",
      "type: dependency\n    name: example-package",
    );
    const oldValidation = {
      ok: false,
      id: "husky",
      issues: [
        { path: "checks.0.version", message: "Invalid input: expected string, received undefined" },
      ],
    };
    const saved = {
      repo: "aranlucas/practices",
      sha,
      practices: [
        {
          id: "husky",
          folder: "husky",
          yaml: presenceYaml,
          instructions: "Keep these instructions.",
          files: {},
          parsed: oldValidation,
        },
        {
          id: "broken",
          folder: "broken",
          yaml: "version: 1\nid: broken\nchecks: []\n",
          instructions: null,
          files: {},
          parsed: parsePractice(validYaml, "husky"),
        },
      ],
    };
    await writeCatalog(env.DB, saved, "2026-10-01T12:00:00.000Z");
    const before = await readCatalogRow(env.DB);

    const loaded = await readStoredCatalog(env.DB);

    expect(loaded).toMatchObject({
      repo: saved.repo,
      sha,
      // Practices come back sorted by id, the same order loadCatalog stores.
      practices: [
        { id: "broken", parsed: { ok: false } },
        { yaml: presenceYaml, instructions: "Keep these instructions.", parsed: { ok: true } },
      ],
    });
    expect(await readCatalogRow(env.DB)).toEqual(before);
  });

  it("reports a catalog that is not installed", async () => {
    await expect(loadCatalog(appEnv)).rejects.toEqual(
      new CatalogUnavailableError("aranlucas/practices"),
    );
  });

  it("loads a custom mixed-case catalog from the case-matching inventory row", async () => {
    await env.DB.prepare(
      `INSERT INTO repositories
       (full_name, owner, name, installation_id, private, archived, fork, language,
        default_branch, pushed_at, html_url, synced_at)
       VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "acme/practicecatalog",
        "acme",
        "practicecatalog",
        1,
        "TypeScript",
        "main",
        null,
        "https://github.com/acme/practicecatalog",
        new Date().toISOString(),
      )
      .run();

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const result = response(url, {
        token: "installation-token-1",
        expires_at: "2030-01-01T00:00:00Z",
      });

      if (request.method === "POST") {
        return Promise.resolve(result);
      }

      if (url.pathname === "/repos/acme/practicecatalog") {
        return Promise.resolve(response(url, { default_branch: "main" }));
      }

      if (url.pathname === "/repos/acme/practicecatalog/commits/main") {
        return Promise.resolve(response(url, { sha }));
      }

      if (url.pathname.endsWith(`/git/trees/${sha}`)) {
        return Promise.resolve(response(url, { truncated: false, tree: [] }));
      }

      throw new Error(`Unexpected GitHub request: ${request.method} ${request.url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    try {
      const catalog = await loadCatalog({
        ...appEnv,
        CATALOG_REPO: "ACME/PracticeCatalog",
      });
      expect(catalog.repo).toBe("ACME/PracticeCatalog");
      expect(fetchMock.mock.calls.map(([input]) => new Request(input).url)).toContain(
        "https://api.github.com/repos/acme/practicecatalog",
      );
      expect((await readStoredCatalog(env.DB))?.repo).toBe("ACME/PracticeCatalog");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
