# Task 5 report: practice schema

## Changes

- Added `src/practices/schema.ts` with strict Zod 4 schemas for all ten check types, defaults, path validation, kind validation, labels, and YAML parsing.
- Exported `RepoPath` for later catalog/evaluation tasks.
- Added the shared branch-protection key tuple to `src/drift/policy.ts` and imported it from the practice schema. The tuple includes the existing drift identifiers and the `required_linear_history` seed-spec compatibility spelling.
- Added complete schema fixtures and validation coverage in `test/practices/schema.test.ts`.

## RED/GREEN validation

- RED: `pnpm vitest run test/practices/schema.test.ts` failed before implementation with `Cannot find module '../../src/practices/schema'`.
- GREEN: `pnpm vitest run test/practices/schema.test.ts` — 1 file, 9 tests passed.
- `pnpm typecheck` — passed.
- `pnpm lint` — passed.
- `pnpm format:check` — passed.
- `pnpm check` — exit 0: 28 test files, 277 tests passed; Cloudflare dry-run build completed successfully.

## Deviations and concerns

The brief refers to an existing exported branch-protection list in `src/drift/policy.ts`, but the repository only had the settings object and an internal list in `src/drift/evaluate.ts`. I added the required shared export in `policy.ts` and included the snake-case `required_linear_history` spelling used by the mandated seed fixture. This is necessary for the specified fixture and keeps the schema independent of the evaluator.

The full check emitted the existing warning about four missing local development secrets during tests; no credentials were added or accessed.
