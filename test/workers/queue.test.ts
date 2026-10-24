import { queueSendResponse } from "@test/helpers/queue";
import type { JsonValue } from "@test/helpers/json";
import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv, EvaluationMessage } from "@/env";
import type { Practice } from "@/practices/schema";
import { type Catalog, type CatalogPractice } from "@/practices/catalog";
import * as evaluate from "@/practices/evaluate";
import * as store from "@/practices/store";
import { upsertRepositories, writeCatalog, type StoredRepository } from "@/practices/store";
import * as jobs from "@/jobs/store";
import { dispatchJobs, reconcileJobs } from "@/jobs/dispatch";
import { enqueueRepositories, handleQueue } from "@/queue";

// SAFETY: cloudflare:test supplies the configured Worker bindings used by queue processing.
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

function response(body: JsonValue, status = 200): Response {
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
  const send = vi.spyOn(appEnv.EVALUATIONS, "send").mockResolvedValue(queueSendResponse);
  const sendBatch = vi.spyOn(appEnv.EVALUATIONS, "sendBatch").mockResolvedValue(queueSendResponse);

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

  await handleQueue(batch, appEnv);

  return getQueueResult(batch, createExecutionContext());
}

async function seed(repos = [repository("octo/demo", 1)]) {
  await upsertRepositories(appEnv.DB, repos, new Date().toISOString());
  await writeCatalog(appEnv.DB, catalog(), new Date().toISOString());

  return repos;
}

interface SweepState {
  pending: number;
  last_completed_at: string | null;
}

interface DispatchState {
  dispatched_at: number;
}

function pending() {
  return appEnv.DB.prepare(
    "SELECT pending, last_completed_at FROM sweep WHERE id = 1",
  ).first<SweepState>();
}

async function makeDue() {
  await appEnv.DB.prepare(
    "UPDATE evaluation_jobs SET available_at = 0 WHERE status = 'pending'",
  ).run();
}

function requiredJobId(body: EvaluationMessage): string {
  if (!body.jobId) {
    throw new Error("Missing job ID");
  }

  return body.jobId;
}

async function leaseFor(id: string) {
  const lease = await jobs.claimJob(appEnv.DB, id);

  if (!lease) {
    throw new Error("Job was not claimable");
  }

  return lease;
}

describe("durable evaluation jobs", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await clearData();
  });

  it.each(["manual", "push", "sweep", "catalog"] as const)(
    "revalidates a repeated %s refresh without downloading unchanged files",
    async (reason) => {
      const [repo] = await seed();
      const definition = practice("readme");

      if (!definition.parsed.ok) {
        throw new Error("Invalid fixture");
      }

      definition.parsed.practice.checks = [
        { type: "file-contains", path: "README.md", text: "readme" },
      ];
      await writeCatalog(
        appEnv.DB,
        { ...catalog(), practices: [definition] },
        new Date().toISOString(),
      );
      mockGitHub();
      const spies = queueSpies();
      await enqueueRepositories(appEnv, [repo], reason);
      await runQueue(spies.messages());
      const previous = await store.readResults(appEnv.DB, repo.fullName);
      vi.mocked(fetch).mockClear();
      spies.sendBatch.mockClear();
      await enqueueRepositories(appEnv, [repo], reason);
      const result = await runQueue(spies.messages());
      expect(result.explicitAcks).toEqual(["message-1"]);
      expect(
        vi
          .mocked(fetch)
          .mock.calls.map(([input, init]) => new URL(new Request(input, init).url).pathname),
      ).toEqual(["/repos/octo/demo/commits/main"]);
      expect(await store.readResults(appEnv.DB, repo.fullName)).toEqual(previous);
    },
  );

  it("completes each job once even when its delivery repeats before another job finishes", async () => {
    const repos = await seed([repository("octo/one", 1), repository("octo/two", 2)]);
    const evaluateMock = vi.spyOn(evaluate, "evaluateRepository").mockResolvedValue("evaluated");
    const spies = queueSpies();
    expect(await enqueueRepositories(appEnv, repos, "sweep")).toBe(2);
    const messages = spies.messages();
    expect(await pending()).toMatchObject({ pending: 2 });
    await runQueue([messages[0]]);
    await runQueue([messages[0]]);
    expect(await pending()).toEqual({ pending: 1, last_completed_at: null });
    expect(evaluateMock).toHaveBeenCalledTimes(1);
    await runQueue([messages[1]]);
    const completed = await pending();
    expect(completed?.pending).toBe(0);
    expect(completed?.last_completed_at).toBeTypeOf("string");
  });

  it("leases a job to one consumer and ignores simultaneous duplicate deliveries", async () => {
    const repos = await seed();
    const spies = queueSpies();
    await enqueueRepositories(appEnv, repos, "push");
    const body = spies.messages()[0];
    const lease = await leaseFor(requiredJobId(body));
    expect(await jobs.claimJob(appEnv.DB, requiredJobId(body))).toBeNull();
    const evaluateMock = vi.spyOn(evaluate, "evaluateRepository");
    await runQueue([body]);
    expect(evaluateMock).not.toHaveBeenCalled();
    expect(await pending()).toMatchObject({ pending: 1 });
    await jobs.finishJob(appEnv.DB, lease, "completed");
    expect(await pending()).toMatchObject({ pending: 0 });
  });

  it("keeps accepted jobs when publishing fails and recovers the outbox", async () => {
    const repos = await seed();
    const spies = queueSpies();
    spies.sendBatch.mockRejectedValueOnce(new Error("queue unavailable"));
    expect(await enqueueRepositories(appEnv, repos, "manual")).toBe(1);
    expect(await pending()).toMatchObject({ pending: 1 });
    expect(
      await appEnv.DB.prepare("SELECT status, dispatched_at FROM evaluation_jobs").first(),
    ).toEqual({ status: "pending", dispatched_at: null });
    await reconcileJobs(appEnv);
    expect(spies.sendBatch).toHaveBeenCalledTimes(2);

    const dispatched = await appEnv.DB.prepare(
      "SELECT dispatched_at FROM evaluation_jobs",
    ).first<DispatchState>();

    expect(dispatched?.dispatched_at).toBeGreaterThan(0);
  });

  it("recovers an ambiguous send using the same job identity", async () => {
    const repos = await seed();
    const spies = queueSpies();
    await enqueueRepositories(appEnv, repos, "push");
    const id = spies.messages()[0].jobId;
    await appEnv.DB.prepare("UPDATE evaluation_jobs SET dispatched_at = 0, available_at = 0").run();
    await dispatchJobs(appEnv);
    expect(spies.messages().map((message) => message.jobId)).toEqual([id, id]);
  });

  it("commits the built-in claim with durable jobs and does not duplicate it after failed dispatch", async () => {
    const repos = await seed();
    const spies = queueSpies();
    spies.sendBatch.mockRejectedValueOnce(new Error("unavailable"));
    expect(
      await enqueueRepositories(appEnv, repos, "catalog", {
        id: "builtins:v2",
        builtInVersion: "v2",
      }),
    ).toBe(1);
    expect(await appEnv.DB.prepare("SELECT built_in_version FROM catalog").first()).toEqual({
      built_in_version: "v2",
    });
    expect(
      await enqueueRepositories(appEnv, repos, "catalog", {
        id: "builtins:v2",
        builtInVersion: "v2",
      }),
    ).toBe(0);
    expect(await pending()).toMatchObject({ pending: 1 });
    expect(
      await appEnv.DB.prepare("SELECT COUNT(*) AS count FROM evaluation_jobs").first(),
    ).toEqual({ count: 1 });
  });

  it("rolls back the built-in claim and all job intents if any transaction statement fails", async () => {
    const repos = await seed();
    await appEnv.DB.prepare(
      "CREATE TRIGGER reject_builtin BEFORE UPDATE OF built_in_version ON catalog BEGIN SELECT RAISE(ABORT, 'synthetic claim failure'); END",
    ).run();

    try {
      await expect(
        jobs.createRun(appEnv.DB, repos, "catalog", { builtInVersion: "v2" }),
      ).rejects.toThrow("synthetic claim failure");
      expect(
        await appEnv.DB.prepare("SELECT COUNT(*) AS count FROM evaluation_jobs").first(),
      ).toEqual({ count: 0 });
      expect(
        await appEnv.DB.prepare("SELECT COUNT(*) AS count FROM evaluation_runs").first(),
      ).toEqual({ count: 0 });
      expect(await pending()).toMatchObject({ pending: 0 });
    } finally {
      await appEnv.DB.prepare("DROP TRIGGER reject_builtin").run();
    }
  });

  it("can invalidate built-ins again after a code rollback restores an earlier version", async () => {
    const repos = await seed();
    expect(await jobs.createRun(appEnv.DB, repos, "catalog", { builtInVersion: "v1" })).toBe(1);
    expect(await jobs.createRun(appEnv.DB, repos, "catalog", { builtInVersion: "v2" })).toBe(1);
    expect(await jobs.createRun(appEnv.DB, repos, "catalog", { builtInVersion: "v1" })).toBe(1);
    await jobs.recoverJobs(appEnv.DB);
    expect(await pending()).toMatchObject({ pending: 1 });
  });

  it("fans out a large run using bounded queue batches", async () => {
    const repos = await seed(
      Array.from({ length: 101 }, (_, index) => repository(`octo/repo-${index}`, 1)),
    );

    const spies = queueSpies();
    expect(await enqueueRepositories(appEnv, repos, "sweep")).toBe(101);
    expect(spies.sendBatch.mock.calls.map(([messages]) => [...messages].length)).toEqual([100, 1]);
    expect(await pending()).toMatchObject({ pending: 101 });
  });

  it("finishes permanent unavailability without replaying the job", async () => {
    const repos = await seed();
    const spies = queueSpies();
    const evaluateMock = vi.spyOn(evaluate, "evaluateRepository").mockResolvedValue("unavailable");
    await enqueueRepositories(appEnv, repos, "push");
    await runQueue(spies.messages());
    await runQueue(spies.messages());
    expect(evaluateMock).toHaveBeenCalledTimes(1);
    expect(await pending()).toMatchObject({ pending: 0 });
  });

  it("supersedes jobs for repositories removed from the inventory", async () => {
    const repos = await seed();
    const spies = queueSpies();
    await enqueueRepositories(appEnv, repos, "push");
    const evaluateMock = vi.spyOn(evaluate, "evaluateRepository");
    await appEnv.DB.prepare("DELETE FROM repositories").run();
    await runQueue(spies.messages());
    expect(evaluateMock).not.toHaveBeenCalled();
    expect((await jobs.readJob(appEnv.DB, requiredJobId(spies.messages()[0])))?.status).toBe(
      "superseded",
    );
    expect(await pending()).toMatchObject({ pending: 0 });
  });

  it("cannot overwrite, mark retrying, or delete current evidence from an older run", async () => {
    const [repo] = await seed();
    await jobs.createRun(appEnv.DB, [repo], "push", { id: "old" });
    const old = await leaseFor(`old:${repo.fullName}`);
    await jobs.createRun(appEnv.DB, [repo], "push", { id: "new" });
    const latest = await leaseFor(`new:${repo.fullName}`);

    const row: store.StoredResult = {
      repo: repo.fullName,
      practiceId: "readme",
      cell: { state: "pass", checkedAt: new Date().toISOString(), failing: 0, unknown: 0 },
      checks: [],
      headSha,
      catalogSha,
    };

    await store.writeResults(appEnv.DB, [row], { ...latest, catalogCommit: catalogSha });
    const guard = { ...old, catalogCommit: catalogSha };
    await store.writeResults(appEnv.DB, [{ ...row, headSha: "old-head" }], guard);
    await store.markUnknown(appEnv.DB, repo.fullName, catalog(), "old failure", guard);
    await store.setResultsRetrying(appEnv.DB, repo.fullName, ["readme"], true, old);
    await store.deleteResultsNotIn(appEnv.DB, repo.fullName, [], guard);
    expect(await store.readResults(appEnv.DB, repo.fullName)).toEqual([
      { ...row, evaluationKey: null },
    ]);
    await jobs.recoverJobs(appEnv.DB);
    expect((await jobs.readJob(appEnv.DB, old.jobId))?.status).toBe("superseded");
  });

  it("rejects writes after catalog replacement, repository removal, or lease expiration", async () => {
    const [repo] = await seed();
    await jobs.createRun(appEnv.DB, [repo], "manual", { id: "run" });
    const lease = await leaseFor(`run:${repo.fullName}`);
    const guard = { ...lease, catalogCommit: catalogSha };
    await writeCatalog(appEnv.DB, { ...catalog(), sha: "new-catalog" }, new Date().toISOString());
    await store.markUnknown(appEnv.DB, repo.fullName, catalog(), "old failure", guard);
    expect(await store.readResults(appEnv.DB, repo.fullName)).toEqual([]);
    await writeCatalog(appEnv.DB, catalog(), new Date().toISOString());
    await appEnv.DB.prepare("UPDATE evaluation_jobs SET lease_until = 0").run();
    await store.markUnknown(appEnv.DB, repo.fullName, catalog(), "expired failure", guard);
    const expiredJob = await jobs.readJob(appEnv.DB, lease.jobId);

    if (!expiredJob) {
      throw new Error("Missing expired job");
    }

    await jobs.createPracticeRetries(appEnv.DB, expiredJob, lease, ["readme"]);
    expect(
      await appEnv.DB.prepare("SELECT COUNT(*) AS count FROM evaluation_jobs").first(),
    ).toEqual({ count: 1 });
    await jobs.finishJob(appEnv.DB, lease, "completed");
    expect((await jobs.readJob(appEnv.DB, lease.jobId))?.status).toBe("running");
    await jobs.recoverJobs(appEnv.DB);
    const reclaimed = await leaseFor(lease.jobId);
    await appEnv.DB.prepare("DELETE FROM repositories").run();
    await store.markUnknown(appEnv.DB, repo.fullName, catalog(), "removed", {
      ...reclaimed,
      catalogCommit: catalogSha,
    });
    expect(await store.readResults(appEnv.DB, repo.fullName)).toEqual([]);
  });

  it("retries unavailable practices independently without redoing healthy results", async () => {
    const [repo] = await seed();
    await writeCatalog(
      appEnv.DB,
      { ...catalog(), practices: [practice("healthy"), practice("first"), practice("second")] },
      new Date().toISOString(),
    );

    const rows = ["healthy", "first", "second"].map((id): store.StoredResult => ({
      repo: repo.fullName,
      practiceId: id,
      cell: {
        state: id === "healthy" ? "pass" : "unknown",
        checkedAt: "2026-10-15T12:00:00Z",
        failing: 0,
        unknown: id === "healthy" ? 0 : 1,
      },
      checks: [],
      headSha,
      catalogSha,
    }));

    await store.writeResults(appEnv.DB, rows);
    const evaluateMock = vi.spyOn(evaluate, "evaluateRepository").mockResolvedValue("retry");
    const spies = queueSpies();
    await enqueueRepositories(appEnv, [repo], "push");
    await runQueue([spies.messages()[0]]);
    const children = spies.messages().filter((body) => body.practiceId);
    expect(children.map((body) => body.practiceId)).toEqual(["first", "second"]);
    expect(await pending()).toMatchObject({ pending: 2 });
    evaluateMock.mockResolvedValue("evaluated");
    await makeDue();
    await runQueue([children[0]]);
    expect(
      (await store.readResults(appEnv.DB, repo.fullName))
        .filter((row) => row.cell.retrying)
        .map((row) => row.practiceId),
    ).toEqual(["second"]);
    await runQueue([children[1]]);
    expect(await pending()).toMatchObject({ pending: 0 });
    expect(
      (await store.readResults(appEnv.DB, repo.fullName)).find(
        (row) => row.practiceId === "healthy",
      ),
    ).toMatchObject(rows[0]);
  });

  it("recovers transient GitHub failures through targeted practice deliveries", async () => {
    const repos = await seed();
    const spies = queueSpies();
    mockGitHub(500);
    await enqueueRepositories(appEnv, repos, "push");
    await runQueue([spies.messages()[0]]);
    const child = spies.messages().find((body) => body.practiceId === "readme");
    expect(child).toBeDefined();
    mockGitHub();
    await makeDue();

    if (!child) {
      throw new Error("Missing practice retry");
    }

    await runQueue([child]);
    expect((await store.readResults(appEnv.DB))[0]?.cell).toMatchObject({ state: "pass" });
    expect(await pending()).toMatchObject({ pending: 0 });
  });

  it("bounds persisted attempts across redeliveries and records terminal failure", async () => {
    const repos = await seed();
    const spies = queueSpies();

    const evaluateMock = vi
      .spyOn(evaluate, "evaluateRepository")
      .mockRejectedValue(new Error("temporary failure"));

    await enqueueRepositories(appEnv, repos, "manual");
    const body = spies.messages()[0];

    const deliverAttempt = async () => {
      await makeDue();
      const result = await runQueue([body]);
      expect(result.explicitAcks).toEqual(["message-1"]);
    };

    await deliverAttempt();
    await deliverAttempt();
    await deliverAttempt();

    await runQueue([body]);
    expect(evaluateMock).toHaveBeenCalledTimes(3);
    expect(
      await appEnv.DB.prepare("SELECT status, attempts, failure FROM evaluation_jobs").first(),
    ).toEqual({ status: "failed", attempts: 3, failure: "Evaluation could not finish" });
    expect(await pending()).toMatchObject({ pending: 0 });
  });

  it("defers a rate-limited repository until reset rather than fanning out practices", async () => {
    const repos = await seed();
    const spies = queueSpies();

    const evaluateMock = vi
      .spyOn(evaluate, "evaluateRepository")
      .mockResolvedValue(new evaluate.EvaluationCooldown(600));

    await enqueueRepositories(appEnv, repos, "sweep");
    const body = spies.messages()[0];
    await runQueue([body]);
    expect((await jobs.readJob(appEnv.DB, requiredJobId(body)))?.available_at).toBeGreaterThan(
      Date.now() + 599_000,
    );
    await runQueue([body]);
    expect(evaluateMock).toHaveBeenCalledTimes(1);
    expect(spies.messages().every((item) => !item.practiceId)).toBe(true);
  });

  it("retries the platform delivery if job state cannot be persisted", async () => {
    const repos = await seed();
    const spies = queueSpies();
    await enqueueRepositories(appEnv, repos, "manual");
    vi.spyOn(evaluate, "evaluateRepository").mockResolvedValue("evaluated");
    vi.spyOn(jobs, "finishJob").mockRejectedValue(new Error("D1 unavailable"));
    vi.spyOn(jobs, "retryJob").mockRejectedValue(new Error("D1 unavailable"));
    const result = await runQueue(spies.messages());
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([{ msgId: "message-1" }]);
  });

  it("persists jobs before a fast consumer runs during send", async () => {
    const repos = await seed();
    mockGitHub();
    let observed: number | undefined;
    vi.spyOn(appEnv.EVALUATIONS, "sendBatch").mockImplementation(async (messages) => {
      observed = (await pending())?.pending;
      await runQueue([...messages].map((message) => message.body));

      return queueSendResponse;
    });
    await enqueueRepositories(appEnv, repos, "manual");
    expect(observed).toBe(1);
    expect(await pending()).toMatchObject({ pending: 0 });
  });

  it("adopts old deliveries idempotently and forces installation permission checks", async () => {
    await seed();
    queueSpies();
    const evaluateMock = vi.spyOn(evaluate, "evaluateRepository").mockResolvedValue("skipped");

    const body: EvaluationMessage = {
      repo: "octo/demo",
      installationId: 1,
      reason: "installation",
    };

    await runQueue([body]);
    await runQueue([body]);
    expect(evaluateMock).toHaveBeenCalledTimes(1);
    expect(evaluateMock).toHaveBeenCalledWith(
      appEnv,
      body.repo,
      expect.objectContaining({ force: true }),
    );
  });
});
