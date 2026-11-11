# Plan 001: Serve a ranked maintenance-priorities queue over MCP and the dashboard API

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0c96f49..HEAD -- src/api/contract.ts src/api/routes.ts src/mcp.ts src/practices/views.ts src/practices/store.ts src/web/routes.ts test/workers/api.test.ts test/workers/mcp-practices.test.ts test/helpers/contract-schemas.ts README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (adds a fourth MCP tool, which changes the tool-list contract on purpose)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `0c96f49`, 2026-11-11

## Why this matters

`ROADMAP.md` lists "A prioritized maintenance inbox" as the **Now** release:
"Group repeated findings into a small queue with affected repositories,
evidence, likely user impact and estimated effort. Keep unknown findings
separate." Its "Next shippable slice" says: "Build the ranked inbox from
existing evaluations". Today, nothing on the server groups or ranks findings.
The MCP `practices_overview` tool returns the raw repo × practice matrix, so an
agent asked "what should I fix next?" has to rebuild the ranking itself and
cannot see the failing checks without one `repo_practices` call per repository.
After this plan lands, one call returns the ranked queue with evidence. Unknown
results stay in a separate list and are never ranked against failures.

## Current state

- `src/mcp.ts` registers exactly three read-only tools (`practices_overview`,
  `repo_practices`, `practice_detail`), all returned through `safely(...)` /
  `jsonResult(...)` and the shared `READ_ONLY_ANNOTATIONS`.
- `src/practices/views.ts` holds the view builders that the API and MCP share
  (`buildOverview`, `buildRepoDetail`, `buildPracticeDetail`). Each one compares
  `result.catalogSha === catalog?.sha` so results from an older catalog never
  appear as current evidence.
- `src/practices/store.ts:421-434` `readResultSummaries` deliberately skips
  `checks_json` ("Overview/counts never transfer or parse detailed check
  evidence"). `readResults(db, repo)` returns full evidence for one repository.
- `src/ui/model.ts:4-8` `cellState`: a cell with `checkedAt === null` (or no
  cell) is `"pending"` in the dashboard, not `unknown`. The dashboard's
  `active` set excludes forks and archived repositories
  (`src/ui/views/overview.tsx:32`).
- `src/web/routes.ts:81-90` `isDashboardApiPath` allowlists the `/app/api/*`
  paths. Any new API path must be added there, or it returns the HTML 404 page.
- Practice definitions have no effort/impact metadata
  (`src/practices/schema.ts`, `PracticeSchema` is `.strict()`). The only
  effort signal is `kind`: `settings` (one repository setting) vs `files` (a
  change committed to each repository).
- Conventions: the shared response types live in `src/api/contract.ts`. The
  strict test schemas live in `test/helpers/contract-schemas.ts`. MCP contract
  tests use the real SDK over `InMemoryTransport`
  (`test/workers/mcp-practices.test.ts`). Pure logic gets a node-project test
  under `test/practices/` (pattern: `test/ui/model.test.ts`).

## Commands you will need

| Purpose   | Command                              | Expected on success                 |
| --------- | ------------------------------------ | ----------------------------------- |
| Install   | `pnpm install --frozen-lockfile`     | exit 0                              |
| Types     | `pnpm types`                         | exit 0                              |
| Typecheck | `pnpm typecheck`                     | exit 0                              |
| Lint      | `pnpm lint && pnpm format:check`     | exit 0                              |
| Tests     | `pnpm test`                          | all pass                            |
| Build     | `pnpm build:preview && pnpm dry-run` | exit 0 (dry run only; never deploy) |

## Scope

**In scope**:

- `src/api/contract.ts`: add `PriorityRepo`, `PriorityAction`, `UnknownFinding`, `PrioritiesResponse`
- `src/practices/priorities.ts` (create): pure `rankPriorities`
- `src/practices/store.ts`: add `readAttentionResults(db, catalogSha)`
- `src/practices/views.ts`: add `buildPriorities(env, { owner?, limit? })`
- `src/api/routes.ts`: `GET /app/api/priorities?owner=&limit=`
- `src/web/routes.ts`: allowlist `priorities` in `isDashboardApiPath`
- `src/mcp.ts`: register `maintenance_priorities`
- `test/practices/priorities.test.ts` (create), `test/workers/api.test.ts`,
  `test/workers/mcp-practices.test.ts`, `test/helpers/contract-schemas.ts`
- `README.md`: the MCP tool list

**Out of scope**:

- A dashboard UI section. Follow-up: the API is ready for it, and it needs its own design pass.
- The "not worth fixing" dismissal action and accepted exceptions. They need storage and design (see the direction notes in `plans/README.md`).
- Effort/impact fields in practice YAML. The schema is strict, so adding them changes the catalog contract.
- Changing the semantics of `practices_overview` or `practice_detail`.

## Steps

### Step 1: Contract types

Add the four interfaces to `src/api/contract.ts`, next to the other GET contracts.
`PrioritiesResponse` = `{ catalog: {sha, loadedAt}, actions, remaining, unknown, unchecked, excluded }`.
Each `PriorityRepo` carries `fullName`, `url`, `checkedAt`, and `checks`
(only the checks in the finding's state).
**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Pure ranking

Create `src/practices/priorities.ts` exporting `rankPriorities(input)`:

- Owner filter, case-insensitive. Drop forks and archived repositories and count them in `excluded`.
- Ignore practices where `valid` is false.
- Per practice and active repository: a missing result or `checkedAt === null` adds the repository to `unchecked`. `fail` goes to the action list, `unknown` to the unknown list, and `pass`/`fail` count toward `evaluated`.
- Sort by number of repositories affected (descending), then `settings` before `files`, then practice id. Apply `limit` and report `remaining`.
  **Verify**: `pnpm exec vitest run test/practices/priorities.test.ts` → all pass.

### Step 3: Store, view, route, tool

- `readAttentionResults`: one SELECT `WHERE catalog_sha = ?` that returns
  `checks_json` only for `fail`/`unknown` rows (`CASE ... ELSE '[]'`).
- `buildPriorities`: read the catalog, catalog row and repositories in parallel, then call `rankPriorities`.
- API route: validate the query with zod (`owner` = `GitHubOwnerInputSchema`, `limit` = 1–100, coerced). A bad query is a 400 through the existing `safeFailure` ZodError branch.
- MCP tool `maintenance_priorities`: input `{ owner?, limit = 5 (1–50) }`, using `READ_ONLY_ANNOTATIONS`.
  **Verify**: `pnpm typecheck && pnpm lint` → exit 0.

### Step 4: Tests and README

**Verify**: `pnpm test` → all pass, including the new cases.

## Test plan

- `test/practices/priorities.test.ts`: ordering (breadth, then kind, then id),
  fork/archived exclusion, unknown kept separate with filtered evidence,
  null-`checkedAt` and missing results count as unchecked, `evaluated` counts
  only pass/fail, invalid practices are ignored, limit/remaining, and the
  case-insensitive owner filter.
- `test/workers/api.test.ts`: the strict contract with the stored failing check as
  evidence, results from a stale catalog are not ranked, the owner filter, and a 400 for `limit=0`.
- `test/workers/mcp-practices.test.ts`: the tool list is now four tools. Cover
  cross-owner ranking, the owner filter with a different letter case, and a tool
  error for an out-of-range limit.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check` exit 0
- [ ] `pnpm test` exits 0
- [ ] `pnpm build:preview && pnpm dry-run` exit 0
- [ ] `git diff --check` clean

## STOP conditions

- Results stop carrying `catalog_sha`, or the composed catalog sha no longer matches it (`buildOverview` logic changed).
- Adding the tool requires changing the MCP auth handler (`src/auth/mcp.ts`).
- The ranking needs data that isn't stored yet (for example history). Don't invent it.

## Maintenance notes

- When effort/impact metadata lands in practice YAML, replace the `KIND_ORDER`
  tie-breaker in `src/practices/priorities.ts`. Keep the primary key (number of
  repositories affected) explainable. The roadmap rules out a blanket score.
- A dismissal/exception feature should filter `rankPriorities` input, not
  rewrite stored results.
- Review the payload size if one practice fails across hundreds of
  repositories. `limit` bounds the number of actions, not repositories per action.
