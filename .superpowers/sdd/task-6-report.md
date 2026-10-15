# Task 6 report: catalog loading

## RED

Command:

```text
pnpm vitest run test/workers/catalog.test.ts
```

Result: failed with exit code 1 because `test/workers/catalog.test.ts` did not exist (`No test files found`). This was a process deviation: it established that the test was absent, rather than proving the requested behavior failed before implementation.

After adding the test, I temporarily disabled `loadCatalog` and reran the focused test. Both tests failed with `Error: implementation disabled for RED evidence` (the success path and the unavailable-installation assertion), providing behavioral RED evidence. The implementation was restored immediately afterward.

## GREEN

Command:

```text
pnpm vitest run test/workers/catalog.test.ts
```

Result: passed, 1 file and 2 tests.

The worker test covers loading the installed catalog from GitHub, default branch and commit SHA resolution, recursive tree filtering, practice parsing and invalid summaries, sorted IDs, README exclusion, D1 persistence and round-trip, and the unavailable-installation error message.

## Changes

- Added `src/practices/catalog.ts` with zod-validated GitHub repository, commit, tree, and blob boundaries; base64 `TextDecoder` content loading; bounded 200-blob and 256 KiB blob guards; truncated-tree failure; catalog parsing, summaries, and unavailable-installation error.
- Extended `src/practices/store.ts` with catalog row read/write helpers.
- Added `test/workers/catalog.test.ts`.

## Final checks

`pnpm check` passed: `cf workers types`, TypeScript, oxlint, formatting, 29 test files / 279 tests, and `cf deploy --dry-run`.

## Deviations and concerns

The initial RED command discovered a missing test file instead of exercising a failing pre-implementation behavior. This is recorded above; the subsequent temporary implementation-disabled run supplied the behavioral RED evidence. No committed source remains disabled.
