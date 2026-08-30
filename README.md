# Shipshape MCP

Shipshape answers a maintainer's most useful question: **what is the next
highest-value thing I should fix across my repositories, and what evidence
supports it?**

It is a read-only remote MCP server running on Cloudflare Workers. GitHub's MCP
already provides excellent repository operations; Shipshape deliberately sits
one level higher, turning repository, branch, CI, security, and release signals
into reproducible scores and ranked actions.

Production endpoint: `https://shipshape-mcp.aranlucas.workers.dev/mcp`

## Tools

| Tool                 | Purpose                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `portfolio_snapshot` | Find the public repositories that most need attention without deep-scanning every project.                                           |
| `repo_readiness`     | Evaluate documentation, licensing, maintenance, metadata, and publication readiness.                                                 |
| `branch_risk`        | Detect stale branches, default-branch drift, conflicts, and rebase risk before work starts.                                          |
| `delivery_hygiene`   | Evaluate CI, pinned Actions, dependency automation, releases, and delivery signals.                                                  |
| `security_posture`   | Normalize security policy, CodeQL, Dependabot, secret scanning, and protection signals without treating unavailable data as success. |
| `action_plan`        | Deduplicate findings into a deterministic, evidence-backed maintenance queue.                                                        |

Every rule returns a stable ID and one of `pass`, `fail`, `unknown`, or
`not_applicable`, plus evidence, confidence, recoverable score, and a concrete
remediation. No LLM decides the score.

## Safety model

- GitHub OAuth requests only `read:user`.
- Tools accept public repositories only and fail closed for private ones.
- The GitHub client exposes no mutation method.
- Shipshape never clones a repository or executes its code.
- Scans have strict page, concurrency, response-size, and timeout bounds.
- Permission- or plan-gated GitHub responses become `unknown`, not `pass`.
- OAuth tokens remain inside encrypted provider props and are never returned or
  logged.
- The Worker uses Cloudflare's OAuth provider for MCP authorization and the
  Worker-compatible `oauth4webapi` library for standards-checked GitHub
  callback and token handling.

See [SECURITY.md](SECURITY.md) and [the architecture](docs/architecture.md) for
the complete trust boundaries.

## Connect

Codex supports the Worker's Streamable HTTP endpoint directly:

```sh
codex mcp add shipshape \
  --url https://shipshape-mcp.aranlucas.workers.dev/mcp \
  --oauth-client-registration auto
```

The first connection opens a consent page, then GitHub login. The consent page
identifies the requesting MCP client and shows the requested scopes.

Other modern MCP clients can use the same `/mcp` URL. Older clients can connect
through `mcp-remote`.

## Develop

Requirements: Node.js 24+, pnpm 11+, and a Cloudflare account with Workers and
KV enabled.

```sh
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
# Fill the three local-only OAuth values in .dev.vars.
pnpm types
pnpm check
pnpm dev
```

Create a GitHub OAuth app with a callback of
`http://localhost:8788/callback`, then connect an MCP Inspector to
`http://localhost:8788/mcp`.

## Deploy

The production OAuth app callback must be
`https://shipshape-mcp.aranlucas.workers.dev/callback`. Store credentials as
Worker secrets; never add them to `wrangler.jsonc`:

```sh
pnpm exec wrangler secret put GITHUB_CLIENT_ID
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
pnpm exec wrangler secret put COOKIE_ENCRYPTION_KEY
pnpm deploy
```

The `OAUTH_KV` binding name is part of the OAuth provider contract and must not
be renamed. Run `pnpm types` after any binding change.

## License

MIT
