# Plan 002: Keep the daily sweep running when the catalog reload fails

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0c96f49..HEAD -- src/scheduled.ts src/index.ts test/workers/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `0c96f49`, 2026-11-11

## Why this matters

The daily cron sweep is the backstop that revalidates the whole portfolio
(`docs/architecture.md`: "the daily sweep also revalidates the portfolio").
Settings, branch protection, and required checks can change without a commit,
so they are rechecked only by a sweep or refresh. Today, one GitHub error while
reloading the catalog repository cancels the whole day's sweep for every
repository, because the enqueue comes after an unguarded `await loadCatalog`.
Evaluation reads only the stored catalog, so the sweep can safely continue
against the last stored catalog.

## Current state

`src/scheduled.ts` (whole file, 24 lines):

```ts
async function inventoryForTrigger(env: AppEnv): Promise<StoredRepository[]> {
  try {
    return await syncInventory(env);
  } catch {
    logger.error("GitHub inventory refresh failed; using stored inventory");

    return listRepositories(env.DB);
  }
}

export async function handleScheduled(env: AppEnv): Promise<void> {
  await pruneSnapshotCache(env.DB);
  const repos = await inventoryForTrigger(env);
  await loadCatalog(env);
  await enqueueRepositories(env, repos, "sweep");
}
```

- `src/practices/catalog.ts:114` `loadCatalog(env)` reads the catalog
  repository from GitHub. It throws `CatalogUnavailableError` and others on
  any read failure, a truncated tree, or an oversized blob.
- `src/practices/catalog.ts:229` `readStoredCatalog(db)` returns the stored
  composed catalog, or `null` before the first load.
- `src/index.ts:60-62` dispatches `handleScheduled` for `DAILY_SWEEP_CRON`.
- No test imports `src/scheduled.ts` (`grep -rn scheduled test/` finds nothing).
- Logging convention: `logger.error("<message>")` or
  `logger.error({ category }, "<event>")`. Logs carry no response bodies or
  tokens (see `src/queue.ts` for examples).

## Commands you will need

| Purpose   | Command                          | Expected |
| --------- | -------------------------------- | -------- |
| Install   | `pnpm install --frozen-lockfile` | exit 0   |
| Types     | `pnpm types`                     | exit 0   |
| Typecheck | `pnpm typecheck`                 | exit 0   |
| Lint      | `pnpm lint && pnpm format:check` | exit 0   |
| Tests     | `pnpm test`                      | all pass |

## Scope

**In scope**: `src/scheduled.ts`, `test/workers/scheduled.test.ts` (create).
**Out of scope**: `loadCatalog` itself. Its strictness is a deliberate
evidence boundary. Also out of scope: the minute reconciliation path, and
`src/index.ts`, except to read the cron constant.

## Steps

### Step 1: Fall back to the stored catalog

Wrap `loadCatalog(env)` the way `inventoryForTrigger` wraps the inventory sync:
on error, log `"Catalog refresh failed; sweeping against the stored catalog"`.
If `readStoredCatalog(env.DB)` returns `null` (no catalog was ever loaded),
rethrow the original error, because there is nothing to evaluate against.
**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Tests

Create `test/workers/scheduled.test.ts`. Model it on the seeding in
`test/workers/api.test.ts` (`upsertRepositories`, `writeCatalog`) and on
`vi.spyOn(appEnv.EVALUATIONS, "sendBatch").mockResolvedValue(queueSendResponse)`.
Cases:

1. GitHub fails for the catalog read (stub `fetch` to return 500), a stored
   catalog exists → `sendBatch` is called with every stored repository and the
   reason `"sweep"`.
2. Same failure with no stored catalog → `handleScheduled` rejects.
   **Verify**: `pnpm exec vitest run test/workers/scheduled.test.ts` → 2 pass.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check` exit 0
- [ ] `pnpm test` exits 0, with the 2 new tests passing
- [ ] Only `src/scheduled.ts` and the new test file are changed (`git status`)

## STOP conditions

- Stubbing `fetch` for the GitHub App token flow can't be done without
  touching shared helpers in `test/helpers/`. Report which helper is missing.
- `enqueueRepositories` turns out to require a freshly loaded catalog.

## Maintenance notes

If the sweep ever becomes a Workflow (see
`docs/research/cloudflare-architecture-assessment.md`), keep this fallback as
its own step.
