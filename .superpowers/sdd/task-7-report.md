# Task 7 implementation report

## RED

Command:

```text
pnpm vitest run test/practices/checks.test.ts test/practices/applies.test.ts test/practices/snapshot.test.ts --reporter=verbose
```

Result before implementation: all three suites failed during module loading with `ERR_MODULE_NOT_FOUND` for `@/practices/applies`, `@/practices/checks`, and `@/practices/snapshot`; 0 tests ran.

## Implementation

- Added `src/practices/applies.ts` for owner, exact-language, repository-glob, archive/fork, and tree-backed `hasFiles` selection.
- Added `src/practices/checks.ts` for every practice check type, explicit unknown handling, result serialization, and fail-over-unknown aggregation.
- Added `src/practices/snapshot.ts` with resolved-head SHA tree/content reads, conditional settings and branch-protection reads, 64-file and 512 KiB bounds, empty-repository 409 handling, and bounded concurrency.
- Added `src/practices/workflows.ts` with the least-privilege, pinned-action, and dependency-review inspectors; exported compatibility helpers from `src/drift/evaluate.ts`.
- Normalized the `required_linear_history` schema compatibility alias to canonical `requiredLinearHistory` in parsed practices.
- Added the required snapshot factory and complete check, applicability, and snapshot test coverage.

## GREEN

Focused command:

```text
pnpm vitest run test/practices/checks.test.ts test/practices/applies.test.ts test/practices/snapshot.test.ts --reporter=dot
```

Result: 3 files passed, 58 tests passed.

Full command:

```text
pnpm check
```

Result: exit 0. `cf workers types`, TypeScript, oxlint, formatting, 32 test files / 337 tests, and `cf deploy --dry-run` all passed.

## Review regression RED/GREEN

The review regression cases were added before the corresponding fixes and run with the focused command above. The pre-fix run reproduced five defects: truncated `hasFiles` applicability returned `false`; absent paths in a complete tree were fetched and converted into read-error unknowns; a complete tree without a dependency-review workflow returned `pass`; a commit endpoint 409 aborted the snapshot before settings and protection reads; and a missing canonical file-match source was evaluated after the absent target. The initial output included the focused assertion failures for those cases (including `expected state: fail, received state: unknown` for the complete-tree absent-content case).

The fixed focused run is green: 3 files passed, 58 tests passed. The complete-tree content path set now contains only paths proven by the tree, workflow inspection is shared through `src/practices/workflows.ts`, no-workflow dependency review fails only for a complete readable tree, commit and tree failures preserve an unknown snapshot while conditional API reads continue, and canonical practice-source availability is checked before the target file.

## Deviations and concerns

The brief's tree URL example uses the default branch, while the repository consistency requirement calls for resolving the branch commit first and pinning both tree and contents reads to that SHA. The implementation uses the resolved head SHA for both requests; the test fixture accepts the resolved SHA route and verifies the resulting snapshot behavior.

Workflow helper code is centralized under `src/practices/workflows.ts`; the old drift module re-exports the helpers for compatibility. No credentials, external writes, resources, remotes, or deployments were used. Full checks emitted only the repository's existing missing-local-secret and Vite native-config warnings.
