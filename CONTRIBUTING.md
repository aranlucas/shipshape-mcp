# Contributing

Shipshape favors evidence over guesses. New checks must be deterministic,
bounded, and testable without executing repository code.

1. Create a branch from the latest fetched `origin/main`.
2. Add or update a stable rule ID and its focused tests.
3. Preserve `pass`, `fail`, `unknown`, and `not_applicable` as distinct states.
   Permission failures must not silently become passes or score penalties.
4. Keep repository evaluation read-only and limited to allowed GitHub App
   installations, including their accessible private repositories. Catalog
   edits use the separate owner-gated catalog write path.
5. Run `pnpm check` and `git diff --check` before opening a pull request.
6. A practice added to `catalog-seed/` is a built-in: it ships with the next
   deploy, alongside its evaluator. A catalog-repository folder with the same
   id overrides it.

Pull requests should explain the evidence a rule consumes, its result states,
and how a maintainer can remediate a failure. Avoid generic GitHub CRUD tools;
Shipshape's purpose is prioritization and policy evaluation.

The complete anti-slop rule set comes from the
`@aranlucas/oxlint-plugin-anti-slop` package. Fix findings rather than
suppressing them. Agent assets are excluded from local formatting and linting.

Tests use synthetic inputs and fail closed on unexpected network traffic.
MCP contract tests use the real SDK over in-memory transports. OAuth integration
runs the actual Worker bundle and provider in local workerd with ephemeral KV;
only explicitly registered synthetic upstream responses are available. Keep
redirects manual and the Node/Worker outbound guards enabled. No test needs
GitHub or Cloudflare credentials, and `pnpm dry-run` must not deploy anything.
