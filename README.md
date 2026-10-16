# Shipshape

[![CI](https://github.com/aranlucas/shipshape-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/aranlucas/shipshape-mcp/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/aranlucas/shipshape-mcp)](LICENSE)

Shipshape checks Lucas's engineering practices across his repositories. A
GitHub App inventories the repositories it can access, reads a versioned
practice catalog, evaluates bounded checks at each default-branch commit, and
stores the results for the dashboard and MCP.

The service covers personal and organization repositories, including private
repositories. The GitHub user token is used only to identify the owner; all
repository reads use installation tokens. Results preserve `pass`, `fail`,
`unknown`, and `not_applicable` states.

## Connect

```bash
codex mcp add shipshape \
  --url https://shipshape-mcp.aranlucas.workers.dev/mcp \
  --oauth-client-registration auto
```

The MCP tools are `practices_overview`, `repo_practices`, and
`practice_detail`. The browser dashboard is available at
[`/app`](https://shipshape-mcp.aranlucas.workers.dev/app).

## Practice catalog

Practices live in the private `aranlucas/practices` catalog repository. Each
practice has a strict `practice.yml` definition and may include canonical files
and agent instructions. Checks cover repository files, JSON/YAML paths,
dependencies, repository settings, branch protection, and workflow security.

The CI practice includes `ci-required-checks`: jobs in `.github/workflows/ci.yml`
must be required status checks on the default branch. It uses each job's `name`
or job ID and allows additional required checks. Dynamic names, matrix jobs,
reusable workflows and unreadable protection settings remain unknown. Shipshape
reports missing requirements and provides remediation instructions without
changing repository settings. Deploy evaluator support before adopting the
updated seed in the separate live catalog.

The CI practice also includes `ci-test-script`: the root `package.json` must
declare a non-empty `scripts.test`, and `.github/workflows/ci.yml` must invoke
it through a package-manager script command or a simple alias. Parallel steps
are supported; conditional, indirect, or failure-ignoring execution needs review.

The `vitest-test-script` check requires every tracked `package.json`, including
nested packages, to declare a test script that runs Vitest (for example,
`"test": "vitest run"`). It reads manifests at the evaluated commit without
executing scripts. Unreadable files, incomplete inventories, and indirect or
complex commands require review and remain unknown.

The `husky-lint-staged` check reads `package.json`, `.husky/pre-commit`, and
recognized root lint-staged configuration files. It checks local dependencies,
Husky initialization through prepare or postinstall, nonempty inline or
JSON/YAML tasks, and a hook invocation that preserves lint failures. Common
npm, pnpm, Yarn and Bun commands and bounded package-script aliases are supported.
It never executes repository commands. Custom installers, shell preambles,
CLI config/cwd/diff selectors, ambiguous configuration and JS/TS tasks require
review and remain unknown. Task execution and machine-local Git settings are
outside this static check.

The dashboard and API contract are documented in
[`docs/architecture.md`](docs/architecture.md); the TypeScript response source
of truth is [`src/api/contract.ts`](src/api/contract.ts). Setup instructions
for the GitHub App, D1 database, queue, and catalog repository are in
[`docs/setup.md`](docs/setup.md).

## Develop

```bash
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
pnpm types
pnpm check
pnpm dev
```

The dashboard is a Preact bundle in `src/ui`. Work on it without GitHub
credentials using fixture data in the API contract's shape:

```bash
pnpm ui:dev   # http://localhost:5200/app/
```

`pnpm ui:build` writes the bundle to `public/app/`, which the Worker serves as
static assets; `pnpm build`, `pnpm dry-run`, and `pnpm preview` run it first.
Run it once before `pnpm dev` so the Worker can serve the dashboard shell.

See [`SECURITY.md`](SECURITY.md) for the security boundary and reporting
instructions.

## Architecture

```mermaid
flowchart LR
  GitHub[GitHub App] --> Inventory[Inventory + installation tokens]
  Catalog[Practice catalog repository] --> Queue[Evaluation queue]
  Inventory --> Queue
  Queue --> Engine[Practice check engine]
  Engine --> DB[(D1 results)]
  DB --> API[Dashboard API]
  DB --> MCP[MCP tools]
```

- `src/github/app.ts` creates App and installation clients.
- `src/inventory/sync.ts` refreshes every installation's repositories.
- `src/practices/` parses the catalog, reads bounded repository snapshots, and
  evaluates checks.
- `src/queue.ts` and `src/scheduled.ts` trigger evaluation after pushes and on
  the daily sweep.
- `src/api/routes.ts` and `src/mcp.ts` expose the shared response contract.

## Local checks

`pnpm check` runs generated Worker types, typechecking, linting, formatting,
the node and Worker test projects, and a Cloudflare dry run. Repository reads
are bounded and no repository code is cloned, executed, or mutated by the
Worker.
