# Shipshape

[![CI](https://github.com/aranlucas/shipshape-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/aranlucas/shipshape-mcp/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/aranlucas/shipshape-mcp)](LICENSE)

Shipshape checks Lucas's engineering practices across personal and organization
repositories, including private repositories. A GitHub App reads repositories;
the dashboard and MCP show stored evidence as `pass`, `fail`, `unknown`, or
`not_applicable`. Only the configured owner can sign in.

## Connect

```bash
codex mcp add shipshape \
  --url https://shipshape-mcp.aranlucas.workers.dev/mcp \
  --oauth-client-registration auto
```

The MCP tools are `maintenance_priorities`, `practices_overview`, `repo_practices`,
and `practice_detail`. `maintenance_priorities` (also `GET /app/api/priorities`)
groups failing results by practice and ranks them by how many active repositories
fail. It includes the failing checks as evidence and lists unknown results separately.
The [dashboard](https://shipshape-mcp.aranlucas.workers.dev/app) and MCP use
[central Auth](https://auth.aranlucas.workers.dev/). Connect GitHub on its
[account page](https://auth.aranlucas.workers.dev/account) before signing in.
See [authentication setup and migration](docs/auth-migration.md) for the
resource, scope, owner gate, and client reconnection requirements.

## Practices

Built-in practices ship from [`catalog-seed/practices/`](catalog-seed/practices).
The private `aranlucas/practices` repository supplies overrides, custom practices,
and disabled markers. [Catalog setup](docs/setup.md#5-create-the-private-catalog-repository)
explains how to edit or reset them without blocking future built-in updates.

Each practice's `instructions.md` contains remediation guidance and check limits.
The [coverage gaps](docs/practice-coverage.md) explain where a passing result still
needs review. The Worker never executes repository code or writes to evaluated
repositories; dashboard edits write only to the allowlisted catalog repository.

## Develop

```bash
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
pnpm types
pnpm check
```

For dashboard work without credentials, run `pnpm ui:dev` and open
`http://localhost:5200/app/`. It uses fixture data.

For the full Worker, follow [local setup](docs/setup.md#6-local-development),
including development Auth configuration and local migrations. Run
`pnpm ui:build` before `pnpm dev` so the Worker can serve the dashboard bundle.

[Deployment setup](docs/setup.md#4-configure-deployed-secrets-and-text-bindings)
covers production releases, migration safety, and Workers Builds.

- [Architecture and consistency boundaries](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)
- [Security and private reporting](SECURITY.md)
- [Product roadmap](ROADMAP.md)
