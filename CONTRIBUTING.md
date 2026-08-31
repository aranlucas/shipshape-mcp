# Contributing

Shipshape favors evidence over guesses. New checks must be deterministic,
bounded, and testable without executing repository code.

1. Create a branch from the latest fetched `origin/main`.
2. Add or update a stable rule ID and its focused tests.
3. Preserve `pass`, `fail`, `unknown`, and `not_applicable` as distinct states.
   Permission failures must not silently become passes or score penalties.
4. Keep GitHub access read-only and public-repository-only.
5. Run `pnpm check` and `git diff --check` before opening a pull request.

Pull requests should explain the evidence a rule consumes, its score impact,
and how a maintainer can remediate a failure. Avoid generic GitHub CRUD tools;
Shipshape's purpose is prioritization and policy evaluation.
