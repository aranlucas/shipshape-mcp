# Plan 004: Skip the built-in requeue work on read paths once the version is claimed

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0c96f49..HEAD -- src/queue.ts src/jobs/store.ts src/api/routes.ts src/auth/mcp.ts test/workers/api.test.ts test/workers/queue.test.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (the D1 claim inside `createRun` stays authoritative)
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `0c96f49`, 2026-11-11

## Why this matters

Every `GET /app/api/overview` awaits `requeueIfBuiltInsChanged` before building
the response. The dashboard polls that endpoint every 3 s while a sweep is
pending (`src/ui/queries.ts`, `POLL_MS = 3_000`). Every authenticated MCP
request also schedules it (`src/auth/mcp.ts:108`). Each call lists every
repository and sends a D1 batch of 1 + 2·⌈repos/100⌉ + 1 statements, which all
do nothing once the version is claimed, and then runs the outbox dispatch
query. That is several D1 round trips and a full table scan per poll, for work
that matters once per deploy. It also makes the read path depend on a D1 write
batch succeeding.

## Current state

`src/queue.ts:185-198`:

```ts
export async function requeueIfBuiltInsChanged(env: AppEnv): Promise<void> {
  if (env.PREVIEW_READ_ONLY === "true") {
    return;
  }

  const builtIns = bundledBuiltIns();

  if (builtIns.practices.length === 0) {
    return;
  }

  await enqueueRepositories(env, await listRepositories(env.DB), "catalog", {
    builtInVersion: builtIns.version,
  });
}
```

- `src/jobs/store.ts:43-57`: the run insert is guarded by
  `EXISTS (SELECT 1 FROM catalog WHERE id = 1 AND sha IS NOT NULL AND built_in_version IS NOT ?)`.
  That guard is the authoritative, race-safe claim (`docs/architecture.md`:
  "Concurrent observers create one run").
- `test/workers/api.test.ts` "requeues every repository once when a deploy
  changes the built-ins" asserts `sendBatch` is called once across two overview reads.

## Commands you will need

| Purpose   | Command                          | Expected |
| --------- | -------------------------------- | -------- |
| Typecheck | `pnpm typecheck`                 | exit 0   |
| Lint      | `pnpm lint && pnpm format:check` | exit 0   |
| Tests     | `pnpm test`                      | all pass |

## Scope

**In scope**: `src/queue.ts` (`requeueIfBuiltInsChanged` only) and `test/workers/api.test.ts`.
**Out of scope**: the `createRun` SQL guard, which must stay unchanged. Also
`enqueueRepositories` callers other than this function.

## Steps

### Step 1: Pre-check the claimed version

Before `listRepositories`, run
`SELECT sha, built_in_version FROM catalog WHERE id = 1`. Return early when the
row is missing, `sha` is null, or `built_in_version === builtIns.version`.
Otherwise continue exactly as today. Don't add module-level caching: isolates
are shared across requests, and the D1 read is the single source of truth.
**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Test

In `test/workers/api.test.ts`'s `built-in practices` describe block, add: after
the first overview read claims the version, spy on `appEnv.DB.batch` and call
the overview again. Expect no `batch` call that inserts into `evaluation_runs`.
The simplest check is that `batch` is not called at all on the second read.
**Verify**: `pnpm exec vitest run test/workers/api.test.ts -t "built-in"` → all pass.

## Done criteria

- [ ] `pnpm test` exits 0, including the existing "requeues every repository once" test
- [ ] `git diff src/jobs/store.ts` is empty

## STOP conditions

- `buildOverview` or another read path relies on `tryDispatchJobs` running
  during the overview request (search the tests for an assertion on dispatch
  during an overview GET). In that case, report back: removing the incidental
  dispatch changes recovery timing.

## Maintenance notes

The minute reconciliation (`reconcileJobs`) still redispatches overdue work,
so skipping the incidental dispatch on reads doesn't strand jobs.
