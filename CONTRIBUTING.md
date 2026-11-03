# Contributing

For a new or changed check, explain the evidence it consumes, its result states,
and how a maintainer can remediate a failure. Preserve the
[security boundary](SECURITY.md): unavailable evidence stays `unknown`, and
repository evaluation never executes repository code or mutates evaluated repositories.

A practice added to `catalog-seed/` ships with its evaluator on the next deploy.
Catalog overrides preserve owner instructions and exceptions; update them through
the catalog's editing workflow rather than replacing them wholesale.

Run `pnpm check` and `git diff --check` before opening a pull request. The former
includes build and deploy dry-run validation; it must not apply migrations or
deploy. Fix shared Oxforge findings rather than suppressing them.

Tests use synthetic inputs and fail closed on unexpected network traffic.
MCP contract tests use the real SDK over in-memory transports. Worker auth tests
exercise resource-server verification with signed JWT/JWKS fixtures. Keep
redirects manual and outbound network guards enabled. Tests need no GitHub or
Cloudflare credentials. See [AGENTS.md](AGENTS.md) for the built-in catalog test
alias and dashboard fixture gotchas.
