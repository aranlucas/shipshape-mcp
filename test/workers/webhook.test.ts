/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/require-readable-spacing, anti-slop/require-safety-comment-for-type-assertion */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "@/env";
import worker from "@/index";
import { upsertRepositories, type StoredRepository } from "@/practices/store";

const appEnv = env as AppEnv;
const origin = "https://shipshape-mcp.aranlucas.workers.dev";

function repository(fullName: string, installationId: number): StoredRepository {
  const [owner, name] = fullName.split("/");

  return {
    fullName,
    owner: owner ?? "owner",
    name: name ?? "repo",
    installationId,
    private: false,
    archived: false,
    fork: false,
    language: "TypeScript",
    defaultBranch: "main",
    pushedAt: "2026-10-15T12:00:00Z",
    url: `https://github.com/${fullName}`,
  };
}

function jsonResponse(url: URL, body: unknown, status = 200): Response {
  const result = Response.json(body, { status });
  Object.defineProperty(result, "url", { value: url.toString() });
  return result;
}

async function signature(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appEnv.GITHUB_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${Buffer.from(digest).toString("hex")}`;
}

function queueSpies() {
  const queue = appEnv.EVALUATIONS;
  const send = vi.spyOn(queue, "send").mockResolvedValue({} as never);
  const sendBatch = vi.spyOn(queue, "sendBatch").mockResolvedValue({} as never);

  return {
    send,
    sendBatch,
    messages: () => [
      ...send.mock.calls.map(([body]) => body),
      ...sendBatch.mock.calls.flatMap(([messages]) => [...messages].map((message) => message.body)),
    ],
  };
}

async function dispatch(event: string, payload: unknown, signed = true): Promise<Response> {
  const body = JSON.stringify(payload);
  const headers = new Headers({
    "content-type": "application/json",
    "x-github-event": event,
  });

  if (signed) {
    headers.set("x-hub-signature-256", await signature(body));
  }

  const ctx = createExecutionContext();
  const result = await worker.fetch(
    new Request(`${origin}/github/webhook`, {
      method: "POST",
      headers,
      body,
    }),
    appEnv,
    ctx,
  );

  await waitOnExecutionContext(ctx);
  return result;
}

async function clearData(): Promise<void> {
  await appEnv.DB.batch([
    appEnv.DB.prepare("DELETE FROM catalog"),
    appEnv.DB.prepare("DELETE FROM repositories"),
    appEnv.DB.prepare("UPDATE sweep SET pending = 0, last_completed_at = NULL WHERE id = 1"),
  ]);
}

describe("GitHub webhook Worker seam", () => {
  beforeEach(async () => {
    await clearData();
    vi.restoreAllMocks();
  });

  it("returns 401 for a bad signature without sending queue work", async () => {
    const spies = queueSpies();
    const payload = {
      ref: "refs/heads/main",
      repository: { full_name: "octo/demo", default_branch: "main" },
      installation: { id: 1 },
    };

    const result = await dispatch("push", payload, false);
    expect(result.status).toBe(401);
    expect(spies.messages()).toEqual([]);
  });

  it("returns 202 and ignores a push to a non-default branch", async () => {
    const spies = queueSpies();
    const payload = {
      ref: "refs/heads/feature",
      repository: { full_name: "octo/demo", default_branch: "main" },
      installation: { id: 1 },
    };

    const result = await dispatch("push", payload);
    expect(result.status).toBe(202);
    expect(spies.messages()).toEqual([]);
  });

  it("enqueues one default-branch push with the push reason", async () => {
    const spies = queueSpies();
    const payload = {
      ref: "refs/heads/main",
      repository: { full_name: "octo/demo", default_branch: "main" },
      installation: { id: 42 },
    };

    const result = await dispatch("push", payload);
    expect(result.status).toBe(202);
    expect(spies.messages()).toEqual([{ repo: "octo/demo", installationId: 42, reason: "push" }]);
  });

  it("reloads the catalog and enqueues every repository for a catalog push", async () => {
    await upsertRepositories(
      appEnv.DB,
      [repository("aranlucas/practices", 1), repository("octo/demo", 1)],
      new Date().toISOString(),
    );
    const catalogSha = "c".repeat(40);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);

      if (request.method === "POST" && url.pathname === "/app/installations/1/access_tokens") {
        return Promise.resolve(
          jsonResponse(url, { token: "installation-token", expires_at: "2030-01-01T00:00:00Z" }),
        );
      }
      if (url.pathname === "/repos/aranlucas/practices") {
        return Promise.resolve(jsonResponse(url, { default_branch: "main" }));
      }
      if (url.pathname === "/repos/aranlucas/practices/commits/main") {
        return Promise.resolve(jsonResponse(url, { sha: catalogSha }));
      }
      if (url.pathname === `/repos/aranlucas/practices/git/trees/${catalogSha}`) {
        return Promise.resolve(jsonResponse(url, { truncated: false, tree: [] }));
      }

      return Promise.resolve(jsonResponse(url, { message: `Unexpected ${url.pathname}` }, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    const spies = queueSpies();

    const result = await dispatch("push", {
      ref: "refs/heads/main",
      repository: { full_name: "ARANLUCAS/PRACTICES", default_branch: "main" },
      installation: { id: 1 },
    });

    expect(result.status).toBe(202);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        new URL(new Request(input).url).pathname.endsWith(`/git/trees/${catalogSha}`),
      ),
    ).toBe(true);
    expect(spies.messages()).toEqual([
      { repo: "aranlucas/practices", installationId: 1, reason: "catalog" },
      { repo: "octo/demo", installationId: 1, reason: "catalog" },
    ]);
  });

  it("answers GitHub ping without queue work", async () => {
    const spies = queueSpies();
    const result = await dispatch("ping", { zen: "Keep it logically awesome." });

    expect(result.status).toBe(200);
    expect(spies.messages()).toEqual([]);
  });

  it("rejects webhook bodies larger than 5 MiB", async () => {
    const spies = queueSpies();
    const result = await dispatch("push", "x".repeat(5 * 1024 * 1024 + 1), false);

    expect(result.status).toBe(413);
    expect(spies.messages()).toEqual([]);
  });

  it("enqueues a repository event even when inventory fields are unchanged", async () => {
    await upsertRepositories(appEnv.DB, [repository("octo/demo", 1)], new Date().toISOString());
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);

      if (request.method === "POST" && url.pathname === "/app/installations/1/access_tokens") {
        return Promise.resolve(
          jsonResponse(url, { token: "installation-token", expires_at: "2030-01-01T00:00:00Z" }),
        );
      }
      if (url.pathname === "/app/installations") {
        return Promise.resolve(
          jsonResponse(url, [{ id: 1, account: { login: "octo", type: "User" } }]),
        );
      }
      if (url.pathname === "/installation/repositories") {
        return Promise.resolve(
          jsonResponse(url, {
            total_count: 1,
            repositories: [
              {
                id: 1,
                name: "demo",
                full_name: "octo/demo",
                private: false,
                html_url: "https://github.com/octo/demo",
                default_branch: "main",
                archived: false,
                fork: false,
                pushed_at: "2026-10-15T12:00:00Z",
                language: "TypeScript",
              },
            ],
          }),
        );
      }
      return Promise.resolve(jsonResponse(url, { message: `Unexpected ${url.pathname}` }, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    const spies = queueSpies();

    const result = await dispatch("repository", {
      repository: { full_name: "octo/demo" },
      installation: { id: 1 },
    });

    expect(result.status).toBe(202);
    expect(spies.messages()).toEqual([
      { repo: "octo/demo", installationId: 1, reason: "installation" },
    ]);
  });

  it("does not enqueue a repository removed by a successful inventory refresh", async () => {
    await upsertRepositories(appEnv.DB, [repository("octo/demo", 1)], new Date().toISOString());
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);

      if (request.method === "POST" && url.pathname === "/app/installations/1/access_tokens") {
        return Promise.resolve(
          jsonResponse(url, { token: "installation-token", expires_at: "2030-01-01T00:00:00Z" }),
        );
      }
      if (url.pathname === "/app/installations") {
        return Promise.resolve(
          jsonResponse(url, [{ id: 1, account: { login: "octo", type: "User" } }]),
        );
      }
      if (url.pathname === "/installation/repositories") {
        return Promise.resolve(jsonResponse(url, { total_count: 0, repositories: [] }));
      }
      return Promise.resolve(jsonResponse(url, { message: `Unexpected ${url.pathname}` }, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    const spies = queueSpies();

    const result = await dispatch("repository", {
      repository: { full_name: "octo/demo" },
      installation: { id: 1 },
    });

    expect(result.status).toBe(202);
    expect(spies.messages()).toEqual([]);
  });
});
