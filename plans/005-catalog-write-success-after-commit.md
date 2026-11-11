# Plan 005: Report a committed catalog change as saved even if the follow-up reload fails

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0c96f49..HEAD -- src/api/routes.ts test/workers/api.test.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `0c96f49`, 2026-11-11

## Why this matters

`handleSave`, `handleDelete` and `handleReset` in `src/api/routes.ts` commit to
the catalog repository and then `await reloadCatalogAndRequeue(env)`, which
reads the whole catalog from GitHub again and writes D1. If that second step
fails, the handler throws, and `safeFailure` returns
`500 "Dashboard API unavailable"` even though the commit landed. The dashboard
then shows the save as failed, skips its `onSuccess` cache invalidation
(`src/ui/mutations.ts`), and invites a retry that creates a second commit. The
catalog push webhook already reloads the catalog later, so the reload here is
an accelerator, not the source of truth.

## Current state

`src/api/routes.ts:108-111`:

```ts
// Results from an older catalog are hidden, so re-evaluate now instead of waiting for the push webhook.
async function reloadCatalogAndRequeue(env: AppEnv): Promise<void> {
  await loadCatalog(env);
  await enqueueRepositories(env, await listRepositories(env.DB), "catalog");
}
```

It is called right after `commitCatalogChange(...)` in `handleSave` (line 144),
`handleDelete` (line 164) and `handleReset` (line 185), each followed by
`return json({ catalogSha }, 200);`.

- `apiHandler(request, env, _session, ctx)` already receives an `ExecutionContext`.
- Logging: `logger.error({ category }, "<event>")`. Never log response bodies.

## Commands you will need

| Purpose   | Command                          | Expected |
| --------- | -------------------------------- | -------- |
| Typecheck | `pnpm typecheck`                 | exit 0   |
| Lint      | `pnpm lint && pnpm format:check` | exit 0   |
| Tests     | `pnpm test`                      | all pass |

## Scope

**In scope**: `src/api/routes.ts` (`reloadCatalogAndRequeue` and its three call
sites) and `test/workers/api.test.ts`.
**Out of scope**: `src/github/catalog-write.ts`, the commit path itself, and
the webhook reload.

## Steps

### Step 1: Make the reload best-effort

Change `reloadCatalogAndRequeue` to catch its error, log
`{ category: error instanceof Error ? error.name : "unknown" }` with the event
`catalog_reload_after_write_failed`, and resolve. Keep awaiting it, so that the
response still reflects the reloaded catalog in the common case and existing
tests that assert immediate reload keep passing.
**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Test

Add an API test modeled on "commits a valid PUT, uses Git Data in sequence, and
reloads the stored catalog". Let the Git Data writes succeed, but make the
follow-up catalog tree read fail (500). Expect status 200 with `catalogSha`
equal to the new commit sha.
**Verify**: `pnpm exec vitest run test/workers/api.test.ts` → all pass.

## Done criteria

- [ ] `pnpm test` exits 0, with the new test passing
- [ ] `git diff --stat` touches only the two in-scope files

## STOP conditions

- The existing `gitDataFetch()` helper can't tell the commit requests apart from
  the reload requests without restructuring it. Report back with what it would take.

## Maintenance notes

If the reload moves to `ctx.waitUntil` later, update the UI so it doesn't
expect results from the new catalog right away.
