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

The complete anti-slop rule set is vendored under `tools/oxlint/anti-slop`, with
its upstream revision and licenses preserved. Keep `oxlint` and
`@oxlint/plugins` pinned to the same version, and fix findings rather than
suppressing them. Agent assets and the vendored plugin are excluded from local
formatting and linting.

Tests use synthetic inputs and fail closed on unexpected network traffic.
MCP contract tests use the real SDK over in-memory transports. OAuth integration
runs the actual Worker bundle and provider in local workerd with ephemeral KV;
only explicitly registered synthetic upstream responses are available. Keep
redirects manual and the Node/Worker outbound guards enabled. No test needs
GitHub or Cloudflare credentials, and `pnpm dry-run` must not deploy anything.
