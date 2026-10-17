# D1 migration and Worker deployment options

Research date: 2026-10-17

Implementation follow-up: the user chose package scripts without a `scripts/`
directory. `config.d1DatabaseId` in `package.json` now supplies the UUID to both
the migration command (through pnpm's `npm_package_config_d1DatabaseId`) and
`cloudflare.config.ts` (through a JSON import). The release runs the native
Cloudflare production dry run before migrations. Workers Builds must switch its
deploy command to `pnpm release:ci` when this change lands. The options below
record the research that preceded that decision.

Scope: decide whether this repository should keep `scripts/deploy.ts`, replace it with package scripts, or rely on the default Cloudflare deployment command. The repository uses `cloudflare.config.ts`, `cf`, the Cloudflare Vite plugin, Workers Builds, and one production D1 binding.

## Findings

### `cf deploy` does not apply D1 migrations

Cloudflare documents `cf deploy` as a build, Build Output validation, Worker Version upload, and deployment operation. Its documented options include `--prebuilt`, `--dry-run`, metadata, secrets, and Worker selection; there is no migration option. Cloudflare's D1 documentation treats `cf d1 migrations apply` as a separate command. Therefore a default `cf deploy` (or a direct `cf deploy --prebuilt`) does not run the checked-in D1 migrations.

Sources: [Cloudflare CLI: Develop, build, and deploy](https://developers.cloudflare.com/cf/projects/) (deploy behavior and options), [Cloudflare CLI: Migrate a Wrangler project](https://developers.cloudflare.com/cf/wrangler/migrate/) (D1 migration command).

### Workers Builds deliberately leaves migration orchestration to the deploy command

Workers Builds runs the configured build command and then the configured deploy command. Cloudflare's own Deploy to Cloudflare guidance says that applications using D1 migrations should put migration application in the package `deploy` script before the Worker deploy. Its example uses Wrangler:

```json
{
  "scripts": {
    "build": "astro build",
    "deploy": "npm run db:migrations:apply && wrangler deploy",
    "db:migrations:apply": "wrangler d1 migrations apply DB_BINDING --remote"
  }
}
```

For this repository, the same shape must use `cf d1 migrations apply` and a database UUID, because the project has migrated to `cloudflare.config.ts` and `cf`.

Sources: [Cloudflare Deploy to Cloudflare buttons: Build/deploy commands and D1 migrations](https://developers.cloudflare.com/workers/platform/deploy-buttons/), [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/).

### `cf` cannot infer the D1 migration target from the Worker binding

The new command is intentionally different from Wrangler:

- `cf d1 migrations apply <DATABASE_ID>` takes a UUID and uses it verbatim in API requests; names and binding names are not accepted.
- `--dir` defaults to `./migrations`; `--pattern` and `--table` are explicit options.
- The command targets the remote database by default; `--local` selects local state.
- The `cloudflare.config.ts` D1 builder has `id`, `name`, and local-development options, but no migration-directory or migration-hook option.
- Ordinary `cf` API commands read only account-level settings from `cloudflare.config.ts`; they do not evaluate the nested Worker configuration to discover a D1 binding.

This means there is no supported native config hook that can turn `cf deploy` into “migrate, then deploy.” A command must provide the UUID separately, or a helper must resolve it from a known artifact/configuration.

Sources: [Cloudflare CLI: Migrate a Wrangler project](https://developers.cloudflare.com/cf/wrangler/migrate/) (UUID-only `cf d1 migrations apply` and options), [Cloudflare CLI: Programmatic configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/) (D1 builder options), [Cloudflare CLI: Develop, build, and deploy](https://developers.cloudflare.com/cf/projects/) (which configuration each command reads), [Cloudflare `cf` changelog](https://github.com/cloudflare/cf/blob/main/packages/cli/CHANGELOG.md) (the command's UUID-only design and Wrangler-compatible bookkeeping).

### Build once, then deploy the exact Build Output

Cloudflare's CI guidance recommends building once and deploying the saved output with the same recorded mode:

```sh
cf build
cf deploy --prebuilt --mode production
```

`--prebuilt` skips the build and automatic configuration. Cloudflare also says that `cf` does not run `package.json` scripts when it invokes the underlying Vite/Cloudflare build tool, so extra build steps must be chained explicitly in the repository's own build script.

The current wrapper's `WORKERS_CI=1` check is compensating for Workers Builds having already run the build command. A cleaner arrangement is to make the Workers Builds deploy command a prebuilt path and keep the build step separate. The deploy step can be a package script or a small migration helper followed by `cf deploy --prebuilt --mode production`.

The production/Preview check must happen before `cf d1 migrations apply`, not only by relying on `cf deploy` to reject a Preview artifact later. Otherwise a mistaken Preview artifact could mutate the production database even though the Worker upload is eventually refused. Likewise, a dry-run path must validate Build Output without applying remote migrations; do not implement dry-run as an unconditional `db:migrate && cf deploy --dry-run` chain.

The repository's pinned pnpm behavior was also checked locally: when a package script invokes a `predeploy` lifecycle script, `pnpm run deploy --dry-run` runs `predeploy` first and forwards `--dry-run` only to `deploy`. A migration placed in `predeploy` would therefore still mutate the remote D1 database during a nominal dry run. Keep migration and dry-run composition explicit.

Sources: [Cloudflare CLI: Use `cf` in CI](https://developers.cloudflare.com/cf/ci/) (build once/prebuilt workflow), [Cloudflare CLI: Develop, build, and deploy](https://developers.cloudflare.com/cf/projects/) (`cf` does not run package scripts and `--prebuilt` behavior).

### Distinguish Wrangler migration guarantees from the new `cf` implementation

Cloudflare's **Wrangler** documentation says its migration command captures a backup and rolls back a failing migration while keeping previously successful migrations applied. That page documents Wrangler; it does not establish identical backup behavior for the newer `cf` command. The installed `cf@1.0.0-beta.17` implementation reads migration bookkeeping, then sends each pending SQL file and its bookkeeping insert through D1's query API. The inspected command contains no explicit backup operation. Do not promise a separate backup per `cf` migration or automatic rollback of the whole release based on the Wrangler page alone. Inspect migration bookkeeping and database state after a failed release before deciding how to recover.

D1 Time Travel provides point-in-time restore for production databases, currently up to 30 days on Workers Paid and 7 days on Workers Free. A restore overwrites the database and cancels in-flight queries, so it is an operational recovery mechanism rather than a normal deploy rollback.

Sources: [Cloudflare D1 Wrangler commands: `d1 migrations apply`](https://developers.cloudflare.com/d1/wrangler-commands/), [Cloudflare D1 Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/). Local first-party implementation checked: `node_modules/cf/dist/d1-Dbs8HItA.mjs`, installed version `1.0.0-beta.17` (the `apply` handler and query helper).

### Worker rollback does not roll back D1

Cloudflare explicitly says that state changes in D1 are not tracked with Worker versions. Its rollback guidance warns that an older Worker can fail when the database structure has changed between the active version and the version being rolled back. Consequently, a production migration must be compatible with both the old and new Worker during the deployment window and with the old Worker if a code rollback is required.

The practical pattern is an additive “expand, deploy, migrate data, contract later” sequence: add new tables/columns/indexes first, deploy code that can use either shape, backfill separately when needed, then remove old schema only after old code cannot return. This sequence is an engineering recommendation inferred from Cloudflare's version/database separation and rollback warning; Cloudflare does not prescribe a D1-specific zero-downtime migration framework in the cited docs.

Sources: [Cloudflare Workers: Versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/) (D1 state is outside Worker versions), [Cloudflare Workers: Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) (old code may fail after a data-structure change).

### Concurrency and serialization are not documented as a Workers Builds guarantee

The reviewed Cloudflare documentation describes migration bookkeeping and failure rollback, but does not promise that two independently triggered `cf d1 migrations apply` processes are serialized by Workers Builds or by the CLI. If multiple production builds can run concurrently, the deployment system should serialize production deploy jobs or use an external CI system with concurrency control. This is an open operational question to verify against the current account/build behavior rather than an assumption to encode in application code.

### Preview deployments need a separate migration decision

`cf previews deploy` produces Worker Previews and uses preview-specific configuration. Cloudflare's preview resource guidance says D1 migrations for a shared preview database need an explicit migration configuration and command; production migrations should not be run accidentally against a Preview binding. The current production artifact guard is useful because it prevents a preview Build Output from entering the production deploy path.

Sources: [Cloudflare Workers: Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) (production versus Preview output), [Cloudflare Docs source: Preview resources and D1 migrations](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers/previews/resources/index.mdx), [Cloudflare CLI: Deploy a preview](https://developers.cloudflare.com/cf/projects/) (preview Build Output and command behavior).

## Options

### 1. Use package scripts plus a migration-only helper — recommended

Keep the helper's only responsibilities as:

1. Assert that the artifact is a production build and resolve the D1 UUID from the same production Worker artifact (or from one explicitly shared source of truth).
2. Run `cf d1 migrations apply <UUID> --dir migrations`.

Let the ordinary Cloudflare command perform deployment, through explicit package-script composition:

```json
{
  "scripts": {
    "db:migrate": "node scripts/migrate.ts",
    "deploy": "cf deploy --prebuilt --mode production",
    "release:ci": "pnpm db:migrate && pnpm run deploy",
    "release": "pnpm build && pnpm release:ci",
    "dry-run": "pnpm build && pnpm run deploy --dry-run"
  }
}
```

This helper-based structure was considered but superseded by the package-only implementation described above. Its artifact check binds the migration UUID to the exact built artifact. The selected implementation instead shares the source UUID and relies on Cloudflare's native preflight. Production releases must build and deploy from the same checkout; reusing an older artifact with changed source resource configuration would lose that identity guarantee.

Configure Workers Builds with `pnpm build` as the build command and `pnpm release:ci` as the deploy command. Local production deployment uses `pnpm release`; CI reuses the artifact. The normal `deploy` command retains Cloudflare's upload/dry-run behavior, while the clearly named release commands apply migrations. `pnpm dry-run` builds and validates without migrations. Production releases must use the release entrypoint; direct `pnpm deploy` bypasses migrations, just as direct `cf deploy` bypasses today's wrapper. Do not append `--dry-run` to a release chain: use the dedicated dry-run command.

This preserves the strongest property of the current implementation: the migration target is checked against the exact artifact being uploaded. It also removes the `WORKERS_CI` branch and the duplicate build. The remaining helper is justified by a real `cf` limitation, not by a missing package-script convenience.

### 2. Replace it with package scripts and an explicit UUID — simplest

If this deployment has exactly one fixed production database and the UUID is intentionally managed as a repository constant, use a package script shaped like:

```json
{
  "scripts": {
    "db:migrate": "cf d1 migrations apply <PRODUCTION_DATABASE_UUID> --dir migrations",
    "deploy": "pnpm build && pnpm db:migrate && cf deploy --prebuilt --mode production",
    "deploy:ci": "pnpm db:migrate && cf deploy --prebuilt --mode production"
  }
}
```

This matches Cloudflare's documented “migrations before deploy” model and is easy to read. It duplicates the UUID already present in `cloudflare.config.ts`, though, so a changed binding can make the migration target and deployed Worker diverge. It also needs a separate dry-run command that omits the migration step. A CI-only deploy command can be written directly in the Workers Builds dashboard, but that makes the safety rule less visible and harder to test locally.

### 3. Move production migrations to external CI — best for approvals/concurrency

Use GitHub Actions or another external CI provider with separate, serialized jobs: build and validate the artifact, apply D1 migrations, then deploy the saved artifact with `cf deploy --prebuilt --mode production`. Cloudflare explicitly supports external CI/CD and documents the same prebuilt workflow for GitHub Actions. This gives a natural place for environment protection, concurrency groups, migration approval, and deploy audit records, but it adds a second deployment system while Workers Builds is already in use.

### 4. Rely on default `cf deploy` — not suitable when migrations are mandatory

This removes the wrapper but silently removes the migration gate. It is appropriate only if D1 schema changes are applied manually or by a separate job and the repository intentionally does not couple schema rollout to Worker rollout.

## Recommendation for this repository

Replace the general deployment wrapper with package-script composition and a migration-only helper. Keep its artifact UUID check and production guard before D1 writes; let `cf deploy` own deployment options and validation. Separate build, deployment, and dry-run paths, so there is no `WORKERS_CI` branch or argument-forwarding wrapper. The current `cf` configuration model has no documented migration hook, and `cf d1 migrations apply` requires a UUID. If the project remains a single fixed production database and duplicated/shared UUID configuration is acceptable, simplify further to a direct `db:migrate` package script, accepting the loss of the pre-migration artifact check.

Regardless of the tooling choice, treat migration files as forward-only, write schema changes for old and new Worker compatibility, serialize production deploys, and use D1 Time Travel only as recovery rather than as a normal rollback mechanism.

## Open questions

- Does this account permit overlapping Workers Builds production jobs? If yes, add CI concurrency control or move production deploys to an external CI workflow.
- Is the D1 UUID expected to vary by mode, preview, or account? If yes, keep artifact/config resolution instead of a package-script literal.
- Are `--profile`, `--secrets-file`, `--tag`, and `--message` required local workflows? If no, removing the argument-forwarding code would make the helper substantially smaller.
- Is the production D1 database on the current Time Travel-supported storage subsystem, and what recovery window is required? Verify before relying on restore as an incident procedure.
