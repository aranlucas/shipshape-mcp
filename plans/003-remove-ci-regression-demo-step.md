# Plan 003: Remove the one-off "Demonstrate audit regressions" CI step

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0c96f49..HEAD -- .github/workflows/ci.yml docs/reliability-audit.md`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `0c96f49`, 2026-11-11

## Why this matters

`AGENTS.md` says: "Distinguish temporary development scaffolding from checks
worth maintaining." `.github/workflows/ci.yml:39-51` runs on every push and
pull request before Lint, Typecheck, Test and Build. It restores three source
files from the hardcoded commit `62172464…` and runs Vitest on four test-name
substrings, then asserts exactly 7 failures and 0 passes. Any unrelated PR that
renames one of those tests, adds a parameterized case, or changes an export the
restored old files import will turn CI red. Contributors then end up debugging
a historical demo. The proof is already recorded in `docs/reliability-audit.md`.

## Current state

- `.github/workflows/ci.yml:39-51`: the step named `Demonstrate audit regressions against pre-fix source`.
- The regression tests it depends on stay in the normal suite:
  `test/workers/catalog-write.test.ts`, `test/web.test.ts`, `test/ui/practice-editor.test.ts`.
- `docs/reliability-audit.md` records the CI run that showed the 7 failures.

## Commands you will need

| Purpose     | Command                                                                                          | Expected |
| ----------- | ------------------------------------------------------------------------------------------------ | -------- |
| Lint        | `pnpm lint && pnpm format:check`                                                                 | exit 0   |
| YAML sanity | `node -e 'require("yaml").parse(require("fs").readFileSync(".github/workflows/ci.yml","utf8"))'` | exit 0   |

## Scope

**In scope**: `.github/workflows/ci.yml` (delete lines 39-51 only).
`docs/reliability-audit.md`: optionally, one sentence noting the step was retired.
**Out of scope**: every other CI step, the e2e job, and the regression tests themselves.

## Steps

### Step 1: Delete the step

Remove the whole `- name: Demonstrate audit regressions against pre-fix source` item, including its `run:` block.
**Verify**: `grep -n "62172464" .github/workflows/ci.yml` → no output. The YAML sanity command exits 0.

## Done criteria

- [ ] `grep -c "Demonstrate audit regressions" .github/workflows/ci.yml` prints `0`
- [ ] `pnpm format:check` exits 0
- [ ] CI on the PR runs the parallel Lint/Typecheck/Test/Build block directly after `Generate Worker types`

## STOP conditions

- The maintainer has documented that the step must stay (search `docs/` and
  `ROADMAP.md` for "Demonstrate audit"). If so, report back instead.

## Maintenance notes

If a future PR wants "fails before the fix" proof, put it in the PR
description, not in CI that runs forever.
