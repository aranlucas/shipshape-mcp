# Shipshape MCP

Shipshape is a read-only MCP server that turns public GitHub repository, branch, delivery, security, and release signals into a ranked maintenance plan.

Production endpoint: `https://shipshape-mcp.aranlucas.workers.dev/mcp`

## Connect

```bash
codex mcp add shipshape \
  --url https://shipshape-mcp.aranlucas.workers.dev/mcp \
  --oauth-client-registration auto
```

Available tools include `portfolio_snapshot`, `repo_readiness`, `branch_risk`, `delivery_hygiene`, `security_posture`, and `action_plan`. Shipshape accepts public repositories only and has no mutation or code-execution capability.

## Develop

```bash
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
pnpm types
pnpm check
pnpm dev
```

See [`SECURITY.md`](SECURITY.md) for the security boundary and report vulnerabilities privately.
