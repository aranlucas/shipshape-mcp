## What changed

<!-- Describe the maintainer outcome, not only the implementation. -->

## Evidence and scoring

<!-- List affected stable rule IDs, evidence sources, and score impact. -->

## Safety

- [ ] GitHub access remains read-only and public-repository-only.
- [ ] Permission failures remain `unknown`, not `pass`.
- [ ] No token, OAuth props, or response bodies are logged.
- [ ] New network work is bounded by timeout, size, page, and concurrency limits.

## Verification

- [ ] `pnpm check`
- [ ] `git diff --check`
