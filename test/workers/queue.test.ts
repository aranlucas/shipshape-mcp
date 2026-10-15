/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-chained-type-assertions, anti-slop/require-readable-spacing, anti-slop/require-safety-comment-for-type-assertion, oxforge/no-inline-types */

import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv, EvaluationMessage } from "@/env";
import type { Practice } from "@/practices/schema";
import { type Catalog, type CatalogPractice } from "@/practices/catalog";
import * as evaluate from "@/practices/evaluate";
import * as store from "@/practices/store";
import { upsertRepositories, writeCatalog, type StoredRepository } from "@/practices/store";
import { enqueueRepositories, handleQueue } from "@/queue";

const appEnv = env as AppEnv;
const headSha = "b".repeat(40);
const catalogSha = "a".repeat(40);

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

function practice(id: string): CatalogPractice {
  const value: Practice = {
    version: 1,
    id,
    title: id,
    summary: `Practice ${id}`,
    kind: "files",
    appliesTo: { include: ["*"], exclude: [], archived: false, forks: false },
    checks: [{ type: "file-exists", path: "README.md", absent: false }],
  };
  return {
    id,
    folder: id,
    yaml: JSON.stringify(value),
    instructions: null,
    files: {},
    parsed: { ok: true, practice: value },
  };
}

function catalog(): Catalog {
  return { repo: "aranlucas/practices", sha: catalogSha, practices: [practice("readme")] };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockGitHub(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const installationMatch = url.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/u);

      if (request.method === "POST" && installationMatch) {
        return Promise.resolve(
          response({
            token: `installation-token-${installationMatch[1]}`,
            expires_at: "2030-01-01T00:00:00Z",
          }),
        );
      }
      if (/\/repos\/[^/]+\/[^/]+\/commits\/main$/u.test(url.pathname)) {
        return Promise.resolve(response({ sha: headSha }));
      }
      if (url.pathname.endsWith(`/git/trees/${headSha}`)) {
        return Promise.resolve(
          response({
            truncated: false,
            tree: [
              { path: "README.md", mode: "100644", type: "blob", sha: "e".repeat(40), size: 1 },
            ],
          }),
        );
      }
      if (url.pathname.endsWith("/contents/README.md")) {
        return Promise.resolve(
          response({ type: "file", encoding: "base64", content: btoa("readme"), size: 6 }),
        );
      }
      return Promise.resolve(response({ message: `Unexpected ${url.pathname}` }, 404));
    }),
  );
}

function queueSpies() {
  const send = vi.spyOn(appEnv.EVALUATIONS, "send").mockResolvedValue({} as never);
  const sendBatch = vi.spyOn(appEnv.EVALUATIONS, "sendBatch").mockResolvedValue({} as never);
  return {
    send,
    sendBatch,
    messages: () => [
      ...send.mock.calls.map(([body]) => body),
      ...sendBatch.mock.calls.flatMap(([messages]) => [...messages].map((message) => message.body)),
    ],
  };
}

async function clearData(): Promise<void> {
  await appEnv.DB.batch([
    appEnv.DB.prepare("DELETE FROM results"),
    appEnv.DB.prepare("DELETE FROM catalog"),
    appEnv.DB.prepare("DELETE FROM repositories"),
    appEnv.DB.prepare("UPDATE sweep SET pending = 0, last_completed_at = NULL WHERE id = 1"),
  ]);
}

async function runQueue(messages: EvaluationMessage[]) {
  const batch = createMessageBatch<EvaluationMessage>(
    "shipshape-evaluations",
    messages.map((body, index) => ({
      id: `message-${index + 1}`,
      timestamp: Date.now(),
      attempts: 1,
      body,
    })),
  );
  const ctx = createExecutionContext();
  await handleQueue(batch, appEnv);
  return { batch, result: await getQueueResult(batch, ctx) };
}

describe("evaluation queue Worker seam", () => {
  beforeEach(async () => {
    await clearData();
    vi.restoreAllMocks();
  });

  it("evaluates and acknowledges both messages in a batch", async () => {
    const repos = [repository("octo/one", 1), repository("octo/two", 2)];
    await upsertRepositories(appEnv.DB, repos, new Date().toISOString());
    await writeCatalog(appEnv.DB, catalog(), new Date().toISOString());
    mockGitHub();

    const { result } = await runQueue(
      repos.map((repo) => ({
        repo: repo.fullName,
        installationId: repo.installationId,
        reason: "push" as const,
      })),
    );

    expect(result.explicitAcks).toEqual(["message-1", "message-2"]);
    expect(result.retryMessages).toEqual([]);
    expect(
      await appEnv.DB.prepare("SELECT COUNT(*) AS count FROM results").first<{ count: number }>(),
    ).toMatchObject({ count: 2 });
    expect(
      await appEnv.DB.prepare("SELECT pending FROM sweep WHERE id = 1").first<{
        pending: number;
      }>(),
    ).toMatchObject({ pending: 0 });
  });

  it("retries a message after evaluation throws with a 60 second delay", async () => {
    await upsertRepositories(appEnv.DB, [repository("octo/demo", 1)], new Date().toISOString());
    await appEnv.DB.prepare("UPDATE sweep SET pending = 1 WHERE id = 1").run();

    vi.spyOn(evaluate, "evaluateRepository").mockRejectedValue(
      new Error("synthetic evaluation failure"),
    );
    const retry = vi.fn();
    const ack = vi.fn();
    const batch = {
      messages: [
        {
          id: "message-1",
          timestamp: new Date(),
          attempts: 1,
          body: { repo: "octo/demo", installationId: 1, reason: "push" as const },
          retry,
          ack,
        },
      ],
    } as unknown as MessageBatch<EvaluationMessage>;
    await handleQueue(batch, appEnv);

    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(
      await appEnv.DB.prepare("SELECT pending, last_completed_at FROM sweep WHERE id = 1").first<{
        pending: number;
        last_completed_at: string | null;
      }>(),
    ).toEqual({ pending: 1, last_completed_at: null });
  });

  it("acknowledges a queued message for a repository deleted from inventory", async () => {
    await appEnv.DB.prepare("UPDATE sweep SET pending = 1 WHERE id = 1").run();
    const retry = vi.fn();
    const ack = vi.fn();
    const batch = {
      messages: [
        {
          id: "message-1",
          timestamp: new Date(),
          attempts: 1,
          body: { repo: "deleted/repository", installationId: 1, reason: "push" as const },
          retry,
          ack,
        },
      ],
    } as unknown as MessageBatch<EvaluationMessage>;

    await handleQueue(batch, appEnv);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(
      await appEnv.DB.prepare("SELECT pending FROM sweep WHERE id = 1").first<{
        pending: number;
      }>(),
    ).toMatchObject({ pending: 0 });
  });

  it("tracks sweep pending from two queued messages to zero with a completion timestamp", async () => {
    const repos = [repository("octo/one", 1), repository("octo/two", 2)];
    await upsertRepositories(appEnv.DB, repos, new Date().toISOString());
    await writeCatalog(appEnv.DB, catalog(), new Date().toISOString());
    mockGitHub();
    const spies = queueSpies();

    await enqueueRepositories(appEnv, repos, "sweep");
    expect(
      await appEnv.DB.prepare("SELECT pending FROM sweep WHERE id = 1").first<{
        pending: number;
      }>(),
    ).toMatchObject({ pending: 2 });
    expect(spies.messages()).toEqual([
      { repo: "octo/one", installationId: 1, reason: "sweep" },
      { repo: "octo/two", installationId: 2, reason: "sweep" },
    ]);

    const { result } = await runQueue(
      repos.map((repo) => ({
        repo: repo.fullName,
        installationId: repo.installationId,
        reason: "sweep" as const,
      })),
    );
    expect(result.explicitAcks).toEqual(["message-1", "message-2"]);
    const sweep = await appEnv.DB.prepare(
      "SELECT pending, last_completed_at FROM sweep WHERE id = 1",
    ).first<{ pending: number; last_completed_at: string | null }>();
    expect(sweep?.pending).toBe(0);
    expect(sweep?.last_completed_at).toEqual(expect.any(String));
  });

  it.each(["push", "installation", "manual", "catalog"] as const)(
    "tracks pending for %s messages too",
    async (reason) => {
      const repos = [repository("octo/one", 1), repository("octo/two", 2)];
      await upsertRepositories(appEnv.DB, repos, new Date().toISOString());
      await writeCatalog(appEnv.DB, catalog(), new Date().toISOString());
      mockGitHub();
      const spies = queueSpies();

      await enqueueRepositories(appEnv, repos, reason);
      expect(
        await appEnv.DB.prepare("SELECT pending FROM sweep WHERE id = 1").first<{
          pending: number;
        }>(),
      ).toMatchObject({ pending: 2 });
      expect(spies.messages()).toHaveLength(2);

      const { result } = await runQueue(
        repos.map((repo) => ({
          repo: repo.fullName,
          installationId: repo.installationId,
          reason,
        })),
      );
      expect(result.explicitAcks).toHaveLength(2);
      expect(
        await appEnv.DB.prepare("SELECT pending FROM sweep WHERE id = 1").first<{
          pending: number;
        }>(),
      ).toMatchObject({ pending: 0 });
    },
  );

  it("rolls back pending reservations when queue publishing fails", async () => {
    const repos = [repository("octo/one", 1), repository("octo/two", 2)];
    vi.spyOn(appEnv.EVALUATIONS, "sendBatch").mockRejectedValue(new Error("queue unavailable"));

    await expect(enqueueRepositories(appEnv, repos, "push")).rejects.toThrow("queue unavailable");
    expect(
      await appEnv.DB.prepare("SELECT pending FROM sweep WHERE id = 1").first<{
        pending: number;
      }>(),
    ).toMatchObject({ pending: 0 });
  });

  it("reserves pending before a fast consumer can run during publishing", async () => {
    const repo = repository("octo/one", 1);
    await upsertRepositories(appEnv.DB, [repo], new Date().toISOString());
    await writeCatalog(appEnv.DB, catalog(), new Date().toISOString());
    mockGitHub();
    let observedPending: number | null = null;
    vi.spyOn(appEnv.EVALUATIONS, "sendBatch").mockImplementation(async (messages) => {
      observedPending =
        (
          await appEnv.DB.prepare("SELECT pending FROM sweep WHERE id = 1").first<{
            pending: number;
          }>()
        )?.pending ?? null;
      const batch = createMessageBatch<EvaluationMessage>(
        "shipshape-evaluations",
        [...messages].map((message) => ({
          id: "message-1",
          timestamp: Date.now(),
          attempts: 1,
          body: message.body,
        })),
      );
      await handleQueue(batch, appEnv);
      return {} as never;
    });

    await enqueueRepositories(appEnv, [repo], "push");

    expect(observedPending).toBe(1);
    expect(
      await appEnv.DB.prepare("SELECT pending FROM sweep WHERE id = 1").first<{
        pending: number;
      }>(),
    ).toMatchObject({ pending: 0 });
  });

  it("does not acknowledge when completion bookkeeping fails", async () => {
    await upsertRepositories(appEnv.DB, [repository("octo/demo", 1)], new Date().toISOString());
    const evaluation = vi.spyOn(evaluate, "evaluateRepository").mockResolvedValue("evaluated");
    const complete = vi
      .spyOn(store, "completePendingMessage")
      .mockRejectedValue(new Error("D1 unavailable"));
    const retry = vi.fn();
    const ack = vi.fn();
    const batch = {
      messages: [
        {
          id: "message-1",
          timestamp: new Date(),
          attempts: 1,
          body: { repo: "octo/demo", installationId: 1, reason: "push" as const },
          retry,
          ack,
        },
      ],
    } as unknown as MessageBatch<EvaluationMessage>;

    await handleQueue(batch, appEnv);

    expect(evaluation).toHaveBeenCalledWith(appEnv, "octo/demo", { force: false });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  });

  it("forces installation and sweep evaluations even when their SHA is unchanged", async () => {
    await upsertRepositories(
      appEnv.DB,
      ["push", "installation", "sweep", "manual", "catalog"].map((reason) =>
        repository(`octo/${reason}`, 1),
      ),
      new Date().toISOString(),
    );
    const evaluation = vi.spyOn(evaluate, "evaluateRepository").mockResolvedValue("skipped");
    const messages = (["push", "installation", "sweep", "manual", "catalog"] as const).map(
      (reason, index) => ({
        id: `message-${index + 1}`,
        timestamp: new Date(),
        attempts: 1,
        body: { repo: `octo/${reason}`, installationId: 1, reason },
        retry: vi.fn(),
        ack: vi.fn(),
      }),
    );

    await handleQueue({ messages } as unknown as MessageBatch<EvaluationMessage>, appEnv);

    expect(evaluation.mock.calls.map(([, , options]) => options)).toEqual([
      { force: false },
      { force: true },
      { force: true },
      { force: true },
      { force: true },
    ]);
  });
});
