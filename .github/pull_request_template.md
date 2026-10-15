## What changed

<!-- Describe the maintainer outcome, not only the implementation. -->

## Evidence and results

<!-- List affected stable rule IDs, evidence sources, and result states. -->

## Safety

- [ ] Repository evaluation stays read-only within allowed GitHub App installations.
- [ ] Permission failures remain `unknown`, not `pass`.
- [ ] No token, OAuth props, or response bodies are logged.
- [ ] New network work is bounded by timeout, size, page, and concurrency limits.

## Verification

- [ ] `pnpm check`
- [ ] `git diff --check`
