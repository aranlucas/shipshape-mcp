import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "@/env";
import { syncInventory } from "@/inventory/sync";
import {
  deleteRepositoriesNotIn,
  listRepositories,
  upsertRepositories,
  type StoredRepository,
} from "@/practices/store";

/* oxlint-disable anti-slop/require-readable-spacing */

interface RepositoryOptions {
  private?: boolean;
  archived?: boolean;
  fork?: boolean;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface StoredRow {
  full_name: string;
  installation_id: number;
  private: number;
  archived: number;
  fork: number;
}

interface CountRow {
  count: number;
}

type PageMode = "normal" | "insufficient" | "malformed";

const repository = (owner: string, name: string, options: RepositoryOptions = {}) => ({
  id: `${owner}/${name}`.length,
  name,
  full_name: `${owner}/${name}`,
  private: options.private ?? false,
  html_url: `https://github.com/${owner}/${name}`,
  default_branch: "main",
  archived: options.archived ?? false,
  fork: options.fork ?? false,
  pushed_at: "2026-10-15T12:00:00Z",
  language: "TypeScript",
});

const installations = [
  { id: 1, account: { login: "aranlucas", type: "User" } },
  { id: 2, account: { login: "sidequest-labs", type: "Organization" } },
];

describe("repository inventory", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM results"),
      env.DB.prepare("DELETE FROM repositories"),
    ]);
  });

  it("syncs every installed repository and removes stale repositories and results", async () => {
    let secondRun = false;
    let pageMode: PageMode = "normal";
    let failingInstallation: number | null = null;
    const sidequestRepositories = [repository("sidequest-labs", "service")];

    const fetchMock = vi.fn(
      (input: RequestInfo | URL, requestInit?: RequestInit): Promise<Response> => {
        const request = new Request(input, requestInit);
        const url = new URL(request.url);

        const jsonResponse = (body: JsonValue, responseInit?: ResponseInit) => {
          const response = Response.json(body, responseInit);
          Object.defineProperty(response, "url", { value: url.toString() });

          return response;
        };

        if (
          request.method === "POST" &&
          /\/app\/installations\/\d+\/access_tokens$/u.test(url.pathname)
        ) {
          const installationId = url.pathname.split("/")[3];

          return Promise.resolve(
            jsonResponse({
              token: `installation-token-${installationId}`,
              expires_at: "2030-01-01T00:00:00Z",
            }),
          );
        }

        if (request.method === "GET" && url.pathname === "/app/installations") {
          return Promise.resolve(jsonResponse(installations));
        }

        if (request.method === "GET" && url.pathname === "/installation/repositories") {
          const page = Number(url.searchParams.get("page") ?? "1");
          const installationId = request.headers.get("authorization")?.endsWith("2") ? 2 : 1;

          if (failingInstallation === installationId) {
            return Promise.resolve(new Response("synthetic failure", { status: 400 }));
          }

          const aranRepositories = [
            repository("aranlucas", "private-project", { private: true }),
            repository("aranlucas", "archived-project", { archived: true }),
            repository("aranlucas", "fork-project", { fork: true }),
            ...(failingInstallation === 2
              ? [repository("aranlucas", "updated-during-partial-sync")]
              : []),
            ...(secondRun ? [] : [repository("aranlucas", "stale-project")]),
          ];

          const repositories = installationId === 1 ? aranRepositories : sidequestRepositories;

          if (installationId === 1 && pageMode !== "normal") {
            const incomplete = aranRepositories.slice(0, -1);

            return Promise.resolve(
              jsonResponse({
                total_count: pageMode === "malformed" ? "4" : aranRepositories.length,
                repositories: incomplete,
              }),
            );
          }

          if (installationId === 2 && page === 2) {
            return Promise.resolve(
              jsonResponse(
                {
                  total_count: repositories.length + 1,
                  repositories: [repository("sidequest-labs", "worker")],
                },
                { headers: { link: "" } },
              ),
            );
          }

          return Promise.resolve(
            jsonResponse(
              {
                total_count: repositories.length + (installationId === 2 ? 1 : 0),
                repositories,
              },
              {
                headers:
                  installationId === 2
                    ? {
                        link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"',
                      }
                    : undefined,
              },
            ),
          );
        }

        throw new Error(`Unexpected GitHub request: ${request.method} ${request.url}`);
      },
    );

    vi.stubGlobal("fetch", fetchMock);

    try {
      // SAFETY: cloudflare:test provides every runtime binding used by syncInventory; its generated Env omits only the typed OAuth helper.
      const appEnv = env as AppEnv;
      const first = await syncInventory(appEnv);
      expect(first.map((repo) => repo.fullName).toSorted()).toEqual([
        "aranlucas/archived-project",
        "aranlucas/fork-project",
        "aranlucas/private-project",
        "aranlucas/stale-project",
        "sidequest-labs/service",
        "sidequest-labs/worker",
      ]);

      const stored = await env.DB.prepare(
        "SELECT full_name, installation_id, private, archived, fork FROM repositories ORDER BY full_name",
      ).all<StoredRow>();

      expect(stored.results).toEqual([
        {
          full_name: "aranlucas/archived-project",
          installation_id: 1,
          private: 0,
          archived: 1,
          fork: 0,
        },
        {
          full_name: "aranlucas/fork-project",
          installation_id: 1,
          private: 0,
          archived: 0,
          fork: 1,
        },
        {
          full_name: "aranlucas/private-project",
          installation_id: 1,
          private: 1,
          archived: 0,
          fork: 0,
        },
        {
          full_name: "aranlucas/stale-project",
          installation_id: 1,
          private: 0,
          archived: 0,
          fork: 0,
        },
        {
          full_name: "sidequest-labs/service",
          installation_id: 2,
          private: 0,
          archived: 0,
          fork: 0,
        },
        {
          full_name: "sidequest-labs/worker",
          installation_id: 2,
          private: 0,
          archived: 0,
          fork: 0,
        },
      ]);

      await env.DB.prepare(
        "INSERT INTO results (repo_full_name, practice_id, state) VALUES (?, ?, ?)",
      )
        .bind("aranlucas/stale-project", "practice", "fail")
        .run();

      secondRun = true;

      const expectIncompleteInventory = async (mode: PageMode, message: string) => {
        pageMode = mode;

        await expect(syncInventory(appEnv)).rejects.toThrow(message);
        expect(
          await env.DB.prepare("SELECT 1 FROM repositories WHERE full_name = ?")
            .bind("aranlucas/stale-project")
            .first(),
        ).not.toBeNull();
      };

      await expectIncompleteInventory("insufficient", "count did not reconcile");
      await expectIncompleteInventory("malformed", "total_count");

      pageMode = "normal";
      const second = await syncInventory(appEnv);
      expect(second.some((repo) => repo.fullName === "aranlucas/stale-project")).toBe(false);
      expect(await listRepositories(env.DB)).toHaveLength(5);
      expect(
        await env.DB.prepare("SELECT 1 FROM results WHERE repo_full_name = ?")
          .bind("aranlucas/stale-project")
          .first(),
      ).toBeNull();

      failingInstallation = 2;
      await expect(syncInventory(appEnv)).rejects.toThrow("synthetic failure");
      expect(
        await env.DB.prepare("SELECT 1 FROM repositories WHERE full_name = ?")
          .bind("sidequest-labs/service")
          .first(),
      ).not.toBeNull();
      expect(
        await env.DB.prepare("SELECT 1 FROM repositories WHERE full_name = ?")
          .bind("aranlucas/updated-during-partial-sync")
          .first(),
      ).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("syncs 101 repositories and removes one on the next complete listing", async () => {
    let secondRun = false;
    const allRepositories = Array.from({ length: 101 }, (_, index) =>
      repository("large-installation", `repo-${index}`),
    );
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, requestInit?: RequestInit): Promise<Response> => {
        const request = new Request(input, requestInit);
        const url = new URL(request.url);
        const jsonResponse = (body: JsonValue) => {
          const response = Response.json(body);
          Object.defineProperty(response, "url", { value: url.toString() });
          return response;
        };

        if (request.method === "POST" && url.pathname === "/app/installations/1/access_tokens") {
          return Promise.resolve(
            jsonResponse({ token: "installation-token-1", expires_at: "2030-01-01T00:00:00Z" }),
          );
        }

        if (request.method === "GET" && url.pathname === "/app/installations") {
          return Promise.resolve(
            jsonResponse([{ id: 1, account: { login: "large-installation", type: "User" } }]),
          );
        }

        if (request.method === "GET" && url.pathname === "/installation/repositories") {
          const repositories = secondRun ? allRepositories.slice(0, -1) : allRepositories;
          return Promise.resolve(jsonResponse({ total_count: repositories.length, repositories }));
        }

        throw new Error(`Unexpected GitHub request: ${request.method} ${request.url}`);
      },
    );

    vi.stubGlobal("fetch", fetchMock);

    try {
      // SAFETY: cloudflare:test provides every runtime binding used by syncInventory; its generated Env omits only the typed OAuth helper.
      const appEnv = env as AppEnv;
      await syncInventory(appEnv);
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS count FROM repositories").first<CountRow>(),
      ).toMatchObject({ count: 101 });

      secondRun = true;
      await syncInventory(appEnv);
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS count FROM repositories").first<CountRow>(),
      ).toMatchObject({ count: 100 });
      expect(
        await env.DB.prepare("SELECT 1 FROM repositories WHERE full_name = ?")
          .bind("large-installation/repo-100")
          .first(),
      ).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a 2,000-repository sync within bounded statement and parameter counts", async () => {
    const allRepositories = Array.from({ length: 2_000 }, (_, index) =>
      repository("large-installation", `repo-${index}`),
    );
    const storedRepositories: StoredRepository[] = allRepositories.map((repo) => ({
      fullName: repo.full_name,
      owner: "large-installation",
      name: repo.name,
      installationId: 1,
      private: repo.private,
      archived: repo.archived,
      fork: repo.fork,
      language: repo.language,
      defaultBranch: repo.default_branch,
      pushedAt: repo.pushed_at,
      url: repo.html_url,
    }));
    await upsertRepositories(env.DB, storedRepositories, new Date().toISOString());
    await deleteRepositoriesNotIn(
      env.DB,
      1,
      storedRepositories.map((repo) => repo.fullName),
    );
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM repositories").first<CountRow>(),
    ).toMatchObject({ count: 2_000 });
  });
});
