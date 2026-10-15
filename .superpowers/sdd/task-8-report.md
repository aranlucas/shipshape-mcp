# Task 8 — Evaluate a repository end to end

## Scope

Implemented the D1 result store and `evaluateRepository` flow. The evaluator loads or reads the catalog, obtains an installation client, reads the repository head, skips only a successful unchanged head/catalog pair, snapshots valid practices, aggregates checks, writes one result batch, and removes obsolete practice rows.

## RED

The initial focused run was intentionally red before implementation:

```text
pnpm vitest run test/workers/evaluate.test.ts
Error: Cannot find package '@/practices/evaluate'
Tests: no tests
```

The test suite covered 12 cases after adding the recovery regressions:

- pass, fail, and language-based not-applicable results;
- unchanged skip with only the head read;
- forced evaluation;
- installation token 404, 401, and 500 failures;
- checked-at preservation and recovery after installation availability returns;
- empty repository tree 409 with settings evaluation continuing;
- repeated null-head and non-null-head unknown evaluations never skipped;
- invalid practice isolation;
- deletion of removed practice results.

## GREEN

Focused validation:

```text
pnpm vitest run test/workers/evaluate.test.ts
Test Files  1 passed (1)
Tests       12 passed (12)
```

Full repository validation:

```text
pnpm check
Test Files  33 passed (33)
Tests       349 passed (349)
cf deploy --dry-run  # build and dry-run completed successfully
```

TypeScript, oxlint, and oxfmt checks all passed as part of `pnpm check`.

## Deviations and concerns

- The implementation catches every installation-token/client acquisition failure and marks the catalog’s repository results unavailable. This follows the design specification’s installation-token failure behavior; the plan’s narrower 404-only wording was insufficient for the required 401/500 tests.
- `takeSnapshot` accepts an optional preloaded head while retaining its original three-argument API. This avoids a duplicate commit read during evaluation and preserves the existing snapshot callers.
- Installation clients used by evaluation disable Octokit retries so deterministic 409 empty-repository responses become unknown results promptly. Other installation-client callers retain their default retry behavior.
- Infrastructure unavailability writes a null head marker and preserves the prior `checked_at`, preventing a recovered repository with the same head/catalog from being skipped forever.
- A non-null head does not by itself prove a completed evaluation: any prior stored unknown count disables the unchanged-evaluation skip, so transient tree, settings, or feature-endpoint failures are retried with the same head/catalog.
- Invalid practices retain their validation issues in the stored catalog (`practiceSummary.error` can expose them), while their result row intentionally remains `unknown` with `checks: []` because the fixed `CellResult`/`StoredResult` contract has no per-cell detail field outside `CheckResult[]`. This is the contract limitation required by the brief.
