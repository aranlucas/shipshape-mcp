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

function mockGitHub(treeStatus = 200): void {
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
        if (treeStatus !== 200) {
          return Promise.resolve(response({ message: "temporary tree failure" }, treeStatus));
        }

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
    appEnv.DB.prepare("DELETE FROM github_snapshot_cache"),
    appEnv.DB.prepare("DELETE FROM results"),
    appEnv.DB.prepare("DELETE FROM catalog"),
    appEnv.DB.prepare("DELETE FROM repositories"),
    appEnv.DB.prepare("UPDATE sweep SET pending = 0, last_completed_at = NULL WHERE id = 1"),
  ]);
}

async function runQueue(messages: EvaluationMessage[], attempts = 1) {
  const batch = createMessageBatch<EvaluationMessage>(
    "shipshape-evaluations",
    messages.map((body, index) => ({
      id: `message-${index + 1}`,
      timestamp: Date.now(),
      attempts,
      body,
    })),
  );
  const ctx = createExecutionContext();
  const retries = batch.messages.map((message) => vi.spyOn(message, "retry"));
  await handleQueue(batch, appEnv);
  return { batch, retries, result: await getQueueResult(batch, ctx) };
}

describe("evaluation queue Worker seam", () => {
  beforeEach(async () => {
    await clearData();
    vi.restoreAllMocks();
  });

  it.each(["manual", "push", "sweep", "catalog"] as const)(
    "revalidates a repeated %s refresh without downloading unchanged files",
    async (reason) => {
      const repo = repository("octo/demo", 1);
      const definition = practice("readme");
      if (!definition.parsed.ok) {
        throw new Error("Invalid fixture");
      }
      definition.parsed.practice.checks = [
        { type: "file-contains", path: "README.md", text: "readme" },
      ];
      definition.yaml = JSON.stringify(definition.parsed.practice);
      await upsertRepositories(appEnv.DB, [repo], new Date().toISOString());
      await writeCatalog(
        appEnv.DB,
        { ...catalog(), practices: [definition] },
        new Date().toISOString(),
      );
      mockGitHub();
      const body: EvaluationMessage = { repo: repo.fullName, installationId: 1, reason };
      await runQueue([body]);
      const previous = await store.readResults(appEnv.DB, repo.fullName);
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockClear();

      const { result } = await runQueue([body]);

      expect(result.explicitAcks).toEqual(["message-1"]);
      const reads = fetchMock.mock.calls
        .map(([input, init]) => new Request(input, init))
        .filter((request) => request.method === "GET")
        .map((request) => new URL(request.url).pathname);
      expect(reads).toEqual(["/repos/octo/demo/commits/main"]);
      expect(await store.readResults(appEnv.DB, repo.fullName)).toEqual(previous);
    },
  );

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

  it("retries an exhausted GitHub 500 and completes pending after recovery at the same SHA", async () => {
    const repo = repository("octo/demo", 1);
    await upsertRepositories(appEnv.DB, [repo], new Date().toISOString());
    await writeCatalog(appEnv.DB, catalog(), new Date().toISOString());
    await appEnv.DB.prepare("UPDATE sweep SET pending = 1 WHERE id = 1").run();
    const message: EvaluationMessage = { repo: repo.fullName, installationId: 1, reason: "push" };
    const spies = queueSpies();
    mockGitHub(500);

    const first = await runQueue([message]);

    expect(first.result.explicitAcks).toEqual(["message-1"]);
    expect(first.result.retryMessages).toEqual([]);
    expect(spies.messages()).toEqual([{ ...message, practiceId: "readme" }]);
    expect(Array.from(spies.sendBatch.mock.calls[0]?.[0] ?? [])[0]).toMatchObject({
      delaySeconds: 60,
    });
    expect((await store.readResults(appEnv.DB, repo.fullName))[0]?.cell.state).toBe("unknown");
    expect(
      await appEnv.DB.prepare("SELECT pending, last_completed_at FROM sweep WHERE id = 1").first(),
    ).toEqual({ pending: 1, last_completed_at: null });

    mockGitHub();
    const recovered = await runQueue(spies.messages());

    expect(recovered.result.explicitAcks).toEqual(["message-1"]);
    expect(recovered.result.retryMessages).toEqual([]);
    expect((await store.readResults(appEnv.DB, repo.fullName))[0]?.cell.state).toBe("pass");
    expect((await store.readResults(appEnv.DB, repo.fullName))[0]?.cell.retrying).toBeUndefined();
    const sweep = await appEnv.DB.prepare(
      "SELECT pending, last_completed_at FROM sweep WHERE id = 1",
    ).first<{ pending: number; last_completed_at: string | null }>();

    expect(sweep?.pending).toBe(0);
    expect(sweep?.last_completed_at).toEqual(expect.any(String));
  });

  it("retries unavailable practices independently and clears loading as each finishes", async () => {
    const repo = repository("octo/demo", 1);
    const practices = [practice("healthy"), practice("first"), practice("second")];
    await upsertRepositories(appEnv.DB, [repo], new Date().toISOString());
    await writeCatalog(appEnv.DB, { ...catalog(), practices }, new Date().toISOString());
    await store.writeResults(
      appEnv.DB,
      practices.map((item) => ({
        repo: repo.fullName,
        practiceId: item.id,
        cell: {
          state: item.id === "healthy" ? "pass" : "unknown",
          checkedAt: "2026-10-15T12:00:00Z",
          failing: 0,
          unknown: item.id === "healthy" ? 0 : 1,
        },
        checks: [],
        headSha,
        catalogSha,
      })),
    );
    const healthy = (await store.readResults(appEnv.DB, repo.fullName)).find(
      (row) => row.practiceId === "healthy",
    );
    await appEnv.DB.prepare("UPDATE sweep SET pending = 1 WHERE id = 1").run();
    const evaluation = vi.spyOn(evaluate, "evaluateRepository").mockResolvedValue("retry");
    const spies = queueSpies();
    await runQueue([{ repo: repo.fullName, installationId: 1, reason: "push" }]);
    const retries = spies.messages();
    expect(retries.map((message) => message.practiceId)).toEqual(["first", "second"]);
    expect(
      (await store.readResults(appEnv.DB, repo.fullName)).filter((row) => row.cell.retrying),
    ).toHaveLength(2);

    evaluation.mockImplementation(async (_env, _repo, options) => {
      if (options?.practiceId === "first") {
        const row = (await store.readResults(appEnv.DB, repo.fullName)).find(
          (item) => item.practiceId === "first",
        );
        if (!row) {
          throw new Error("Missing first practice");
        }
        await store.writeResults(appEnv.DB, [
          { ...row, cell: { ...row.cell, state: "pass", unknown: 0 } },
        ]);
        return "evaluated";
      }
      return "retry";
    });
    const partial = await runQueue(retries);
    expect(partial.result.explicitAcks).toEqual(["message-1"]);
    expect(partial.result.retryMessages).toEqual([{ msgId: "message-2" }]);
    let rows = await store.readResults(appEnv.DB, repo.fullName);
    expect(rows.find((row) => row.practiceId === "first")?.cell).toMatchObject({ state: "pass" });
    expect(rows.filter((row) => row.cell.retrying).map((row) => row.practiceId)).toEqual([
      "second",
    ]);
    expect(rows.find((row) => row.practiceId === "healthy")).toEqual(healthy);
    expect(await appEnv.DB.prepare("SELECT pending FROM sweep WHERE id = 1").first()).toEqual({
      pending: 1,
    });

    await runQueue([retries[1]], 2);
    rows = await store.readResults(appEnv.DB, repo.fullName);
    expect(rows.find((row) => row.practiceId === "second")?.cell).toMatchObject({
      state: "unknown",
    });
    expect(rows.some((row) => row.cell.retrying)).toBe(false);
    expect(await appEnv.DB.prepare("SELECT pending FROM sweep WHERE id = 1").first()).toEqual({
      pending: 0,
    });
  });

  it.each([1, 2, 3])("bounds transient evaluation retries at delivery %s", async (attempts) => {
    await upsertRepositories(appEnv.DB, [repository("octo/demo", 1)], new Date().toISOString());
    await appEnv.DB.prepare("UPDATE sweep SET pending = 1 WHERE id = 1").run();
    vi.spyOn(evaluate, "evaluateRepository").mockResolvedValue("retry");

    const { result, retries } = await runQueue(
      [{ repo: "octo/demo", installationId: 1, reason: "push" }],
      attempts,
    );

    expect(result.explicitAcks).toEqual(attempts === 3 ? ["message-1"] : []);
    expect(result.retryMessages).toEqual(attempts === 3 ? [] : [{ msgId: "message-1" }]);
    expect(retries[0]?.mock.calls).toEqual(
      attempts === 3 ? [] : [[{ delaySeconds: 60 * attempts }]],
    );
    const sweep = await appEnv.DB.prepare(
      "SELECT pending, last_completed_at FROM sweep WHERE id = 1",
    ).first<{ pending: number; last_completed_at: string | null }>();

    expect(sweep?.pending).toBe(attempts === 3 ? 0 : 1);
    expect(Boolean(sweep?.last_completed_at)).toBe(attempts === 3);
  });

  it("acknowledges a permanently unavailable installation without retrying", async () => {
    await upsertRepositories(appEnv.DB, [repository("octo/demo", 1)], new Date().toISOString());
    await appEnv.DB.prepare("UPDATE sweep SET pending = 1 WHERE id = 1").run();
    vi.spyOn(evaluate, "evaluateRepository").mockResolvedValue("unavailable");

    const { result } = await runQueue([{ repo: "octo/demo", installationId: 1, reason: "push" }]);

    expect(result.explicitAcks).toEqual(["message-1"]);
    expect(result.retryMessages).toEqual([]);
    expect(await appEnv.DB.prepare("SELECT pending FROM sweep WHERE id = 1").first()).toEqual({
      pending: 0,
    });
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

  it("completes pending on a final practice attempt even when clearing retrying fails", async () => {
    await upsertRepositories(appEnv.DB, [repository("octo/demo", 1)], new Date().toISOString());
    await appEnv.DB.prepare("UPDATE sweep SET pending = 1 WHERE id = 1").run();
    vi.spyOn(evaluate, "evaluateRepository").mockRejectedValue(
      new Error("D1_ERROR: no such column: retrying"),
    );
    vi.spyOn(store, "setResultsRetrying").mockRejectedValue(
      new Error("D1_ERROR: no such column: retrying"),
    );
    const retry = vi.fn();
    const ack = vi.fn();
    const batch = {
      messages: [
        {
          id: "message-1",
          timestamp: new Date(),
          attempts: 2,
          body: {
            repo: "octo/demo",
            installationId: 1,
            reason: "push" as const,
            practiceId: "readme",
          },
          retry,
          ack,
        },
      ],
    } as unknown as MessageBatch<EvaluationMessage>;

    await handleQueue(batch, appEnv);

    expect(retry).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(1);
    expect(
      await appEnv.DB.prepare("SELECT pending FROM sweep WHERE id = 1").first<{
        pending: number;
      }>(),
    ).toMatchObject({ pending: 0 });
  });

  it("forces installation evaluations and revalidates other triggers using cached results", async () => {
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
      { force: false },
      { force: false },
      { force: false },
    ]);
  });
});
