# Setup

This guide configures the private, single-owner Shipshape deployment. The
commands below are a reference for setting up another instance. This instance
uses the `shipshape-for-aranlucas` GitHub App (ID `5337206`), installed on
`aranlucas` and `sidequest-labs`, and the private `aranlucas/practices` catalog.

## 1. Create the GitHub App

In GitHub, open **Settings → Developer settings → GitHub Apps → New GitHub
App**. Use these values:

- App name: `Shipshape Personal Practices` (or another unique name).
- Homepage URL: `${PUBLIC_ORIGIN}`.
- User sign-in is handled by the central Auth Worker; the installation App needs no Shipshape login callback.
- Turn **Request user authorization (OAuth) during installation** off.
- Enable **Webhook** and set the URL to `${PUBLIC_ORIGIN}/github/webhook`.
- Generate a long random webhook secret and store it in your password manager.

The App permissions are:

| Permission     | Level          | Purpose                                                                    |
| -------------- | -------------- | -------------------------------------------------------------------------- |
| Metadata       | Read-only      | List repositories available to an installation                             |
| Contents       | Read and write | Read repository files; write practice edits only in the catalog repository |
| Administration | Read-only      | Read merge settings, security analysis, rulesets, and branch protection    |
| Pull requests  | Read-only      | Future links to pull requests for fixes                                    |

Contents write is required at the App level because GitHub permissions are
App-wide. Shipshape enforces the write boundary in code: catalog writes are
allowed only for `CATALOG_REPO` (normally `aranlucas/practices`). It does not
write to the repositories being evaluated.

Subscribe to these events:

- `push`
- `installation`
- `installation_repositories`
- `repository`

After creating the App, save its App ID. Generate
the private key, keep the downloaded file outside the repository as `app.pem`,
and convert it to the PKCS#8 PEM format expected by the Worker:

```sh
openssl pkcs8 -topk8 -nocrypt -in app.pem -out app.pkcs8.pem
```

Do not commit either key file. The webhook signature is checked with HMAC-SHA256
against `GITHUB_WEBHOOK_SECRET` using the `X-Hub-Signature-256` header.

## 2. Install the App and identify the owner

Install the App on both `aranlucas` and `sidequest-labs`. Select **All
repositories** in each installation. This gives inventory access to personal
and organization repositories, including private repositories.

Find the numeric GitHub user ID for the owner account:

```sh
gh api user --jq .id
```

Use that value as `OWNER_GITHUB_ID`. The owner gate compares the signed-in
GitHub user ID with this value; a different GitHub account receives `403`.

## 3. Create Cloudflare resources

The project uses the `cf` CLI (`cf@1.0.0-beta.17`). The command forms below
were discovered from the installed CLI with `cf cli search` and command help.
Run them only after authenticating to the intended Cloudflare account. Keep the
IDs returned by the create commands; do not substitute a database name where a
database ID is required.

Create the D1 database, evaluation queue, ingress queue, and dead-letter queues:

```sh
cf d1 create --name shipshape
cf queues create --queue-name shipshape-evaluations
cf queues create --queue-name shipshape-webhooks
cf queues create --queue-name shipshape-evaluations-failed
cf queues create --queue-name shipshape-webhooks-failed
```

The Worker configuration declares `DB`, `EVALUATIONS`, and `WEBHOOKS`. Queue
consumer settings are managed in `cloudflare.config.ts`: evaluation batches of
five with one concurrent invocation, ingress batches of one, and explicit retry
and dead-letter policies. The daily trigger requests a sweep; the minute trigger
repairs dispatch and expired leases.

Apply the checked-in migrations using the D1 database ID returned by the create
command:

```sh
cf d1 migrations apply <D1_DATABASE_ID> --dir migrations
```

The queue consumer batch size is five so a sweep does not exhaust one Worker
invocation's subrequest budget. The cron trigger is `0 13 * * *` UTC.

## 4. Configure deployed secrets and text bindings

Set the text values in the deployment environment:

```sh
export GITHUB_APP_ID=<app-id>
export BETTER_AUTH_ISSUER=https://auth.aranlucas.workers.dev/api/auth
export BETTER_AUTH_JWKS_URL=https://auth.aranlucas.workers.dev/api/auth/jwks
export OWNER_GITHUB_ID=<numeric-owner-id>
```

Set the secret bindings with the installed CLI. Keep the values in local shell
variables or a password manager and never paste real values into this guide or
the repository:

```sh
export GITHUB_APP_PRIVATE_KEY="$(<app.pkcs8.pem)"
export GITHUB_WEBHOOK_SECRET=<webhook-secret>

cf workers secrets update GITHUB_APP_PRIVATE_KEY --worker shipshape-mcp --text "$GITHUB_APP_PRIVATE_KEY"
cf workers secrets update GITHUB_WEBHOOK_SECRET --worker shipshape-mcp --text "$GITHUB_WEBHOOK_SECRET"
```

`CATALOG_REPO` is configured as a text binding and defaults to
`aranlucas/practices`. Set `CATALOG_REPO=owner/name` in the deployment
environment before building or deploying when the catalog repository moves.
The catalog lookup and write allowlist compare repository names
case-insensitively; keep the configured value aligned with an installed
repository.
`PUBLIC_ORIGIN` is the deployed Worker origin and is used to build the OAuth
dashboard callback, resource identifier, and same-origin write checks. The webhook URL uses the same origin.

Configure the central Auth Worker first, following [the auth migration guide](auth-migration.md).
It owns GitHub social credentials and the callback
`https://auth.aranlucas.workers.dev/api/auth/callback/github`. Connect GitHub from
[Auth's account page](https://auth.aranlucas.workers.dev/account). Shipshape
requests `shipshape:access` for its exact `/mcp` resource and accepts only signed
`github_id`/`github_login` claims for `OWNER_GITHUB_ID`. The dashboard registers
a public PKCE client with the exact `${PUBLIC_ORIGIN}/callback/web` redirect;
no dashboard client secret is needed.

`MCP_ALLOWED_ORIGINS` is an optional JSON array of additional browser origins.
The Worker's own origin is always allowed. Origin-less native clients are
accepted; other browser origins must be configured explicitly.

The existing `OAUTH_KV` binding retains its deployed name and is still required
for installation-token caching, dashboard client registration, browser-bound
PKCE state, and hashed session records. OAuth grants now belong to Auth.

Secrets must be configured on the production Worker as well as on any Preview.
A successful Preview deployment does not configure production credentials.
To upload the App secrets together with a production deployment, put them in a
protected JSON file outside the repository and use:

```sh
pnpm build
pnpm run deploy --dry-run
pnpm db:migrate
pnpm run deploy --secrets-file /secure/path/app-secrets.json
```

Use `pnpm release` for a local production release, or `pnpm release:ci` after
`pnpm build`. Both apply pending D1 migrations before uploading the Worker and
stop if validation or migration fails. The release first runs Cloudflare's
prebuilt production dry run, which rejects invalid or Preview output before any
database writes. `pnpm db:migrate` runs `cf d1 migrations apply` directly. Its
database UUID lives in `package.json` under `config.d1DatabaseId`; pnpm exposes
it to the command, and `cloudflare.config.ts` imports the same value for `DB`.
`pnpm run deploy` is the standard `cf deploy` command
for an existing production artifact; it does not build or migrate. Deployment
options such as `--secrets-file`, `--tag`, and `--message` go directly to `cf`.

`pnpm dry-run` builds and validates without applying migrations or uploading.
For an existing build, use `pnpm run deploy --dry-run`. Use these commands for
validation rather than adding `--dry-run` to a release command, which runs the
migration step first. No migration runs through a `predeploy` lifecycle hook.

Configure Workers Builds with **Build command: `pnpm run build`** and
**Deploy command: `pnpm release:ci`**. Replace the previous `pnpm run deploy`
dashboard setting so production builds continue to apply migrations. Other CI
systems use the same build-then-release sequence. Build reuse is explicit and
does not depend on `WORKERS_CI`.

Direct `cf deploy` and `pnpm run deploy` calls bypass the migration gate. The
build token needs D1 edit access for the bound database as well as Worker
deployment access. Both commands inherit the active CLI profile or environment
credentials. For an explicit named profile, build first, then run
`pnpm run deploy --dry-run`, `pnpm db:migrate --profile <name>`, then
`pnpm run deploy --profile <name>`. Changes to an existing schema must remain
compatible with the currently running Worker because migrations run before the
new code is uploaded.

After deployment, sign in and choose **Find my repositories**. On an empty
database this imports the App's installed repositories, loads the catalog,
and queues their first checks. The production queue consumer must be deployed
for those checks to complete; a Preview alone cannot process them.

## 5. Create the private catalog repository

Shipshape's built-in practices (`catalog-seed/practices/`) ship inside the
Worker. The catalog repository holds only your changes, so it can start with
nothing but an initial commit:

```sh
gh repo create aranlucas/practices --private --add-readme
```

Install the GitHub App on it. These commands are documentation only; do not
run them against a real account without reviewing the target first.

The catalog layout is `practices/<id>/practice.yml`, with optional
`instructions.md` and `files/` content. The effective catalog is the built-ins
overlaid by this repository:

- a folder whose id matches a built-in overrides it;
- a `practices/<id>/disabled` file turns that built-in off;
- any other folder adds a custom practice.

The dashboard writes these for you: saving a practice commits its folder,
**Turn off** writes the marker, and **Reset to built-in** or **Turn back on**
removes the folder. Each write is validated and committed only to this
allowlisted catalog repository. A copy identical to its built-in still stops
built-in updates from reaching that practice; the Practices page flags it so
you can reset it.

## 6. Local development

Copy the example file and fill it with development-only values:

```sh
cp .dev.vars.example .dev.vars
pnpm ui:build
pnpm dev
```

The local D1 database starts empty. Apply the migrations to it once per
local state directory, using the local explorer the dev server prints at
startup (`/cdn-cgi/local/explorer/api`):

```sh
DB_ID=$(curl -s "$PUBLIC_ORIGIN/cdn-cgi/local/explorer/api/d1/database" | jq -r '.result[0].uuid')
for file in migrations/*.sql; do
  jq -n --rawfile sql "$file" '{sql: $sql}' |
    curl -s -X POST -H 'Content-Type: application/json' --data @- \
      "$PUBLIC_ORIGIN/cdn-cgi/local/explorer/api/d1/database/$DB_ID/raw"
done
```

`.dev.vars` uses dotenv syntax and is loaded by local Cloudflare development
for secret bindings. It is ignored by Git and must never contain production
credentials in a commit. The text bindings `GITHUB_APP_ID`,
`BETTER_AUTH_ISSUER`, `BETTER_AUTH_JWKS_URL`, and `OWNER_GITHUB_ID` are read from `process.env` by
`cloudflare.config.ts`, so export those values before starting `pnpm dev` if
you do not put them in the config's development environment.

Cloudflare's local-development behavior is specific about process variables:
if no `.dev.vars` file is present, set
`CLOUDFLARE_INCLUDE_PROCESS_ENV=true` to include the process environment as
local development variables. Choose `.dev.vars` or process-environment loading
for a session; do not rely on both sources silently overriding each other.

For a direct localhost server, set both `PUBLIC_ORIGIN` and `PORTLESS_URL` to
the server origin before starting Vite. `PUBLIC_ORIGIN` controls OAuth and
same-origin write checks; `PORTLESS_URL` controls local MCP metadata defaults.

Before opening the dashboard, configure the local `/mcp` resource and exact
`/callback/web` redirect in a development Auth instance. The production Auth
resource policy accepts only declared resources. Keep the GitHub webhook URL
aligned with the local `PUBLIC_ORIGIN`. Local D1 and Queue
simulations are safe for development; use the configured Cloudflare resources
only when you intentionally test the deployed integration.

## 7. Branch previews

`pnpm preview` builds and deploys the current branch without queue consumers
or cron triggers, which Cloudflare Previews do not support. The dashboard
login and MCP discovery use the incoming Preview origin. Configure that exact
`https://<preview-host>/mcp` resource and `/callback/web` redirect in a test Auth
instance before testing sign-in. The production Auth policy accepts only its
declared resource URLs; it does not automatically trust preview origins.

Preview secrets are separate from production secrets. Upload a protected JSON
file containing `GITHUB_APP_PRIVATE_KEY` (PKCS#8) and
`GITHUB_WEBHOOK_SECRET` using Wrangler's Preview secret command. The installed
`cf` version does not expose this command; Wrangler `4.151.0` is also present
as a transitive dependency, or can be invoked explicitly:

```sh
npx wrangler@4.151.0 preview secret bulk /secure/path/preview-secrets.json \
  --worker-name shipshape-mcp --name '<branch-name>'
```

This updates only the named Preview deployment. Do not use a production
`workers secrets` command when the intended target is a Preview.

Previews require dedicated resources and do not fall back to production:

```sh
cf d1 create --name shipshape-preview
cf kv namespaces create --title shipshape-preview-oauth
cf queues create --queue-name shipshape-preview-evaluations
cf queues create --queue-name shipshape-preview-webhooks
```

The project records its shared preview resource IDs in `package.json` as
`config.previewD1DatabaseId` and `config.previewOAuthKvId`, so Workers Builds
can build previews without additional build variables. Set
`PREVIEW_D1_DATABASE_ID` or `PREVIEW_OAUTH_KV_ID` to override either binding for
a branch that needs its own resources. Both must differ from production.
Apply migrations to the preview database explicitly with
`cf d1 migrations apply <PREVIEW_DATABASE_ID> --dir migrations`. The build fails
if neither project config nor the environment supplies the resource IDs, or if
they point at production.

`pnpm build:preview` validates the preview build without uploading it. CI and
`pnpm check` build both preview and production modes; the production build runs
last so the final artifact remains ready for a production release.

Preview dashboard/API reads and sign-in work against those separate resources.
Dashboard mutations and webhook acceptance return `403`; built-in maintenance
is disabled. Previews have no consumers or cron triggers. Seed the preview D1
catalog/results with test data, and use local simulation for the full processing
flow. A preview never writes the configured GitHub catalog through its API.

## 8. Durable-job rollout and recovery

Apply `0006_evaluation_jobs.sql` through the normal release entrypoint and create
the ingress/dead-letter queues above before enabling the new Worker. For the
first rollout, pause the evaluation consumer and let existing invocations finish
before migrating/deploying; resume it after deployment. This avoids an old
Worker invocation publishing unguarded results while new generations are active.
Old queued messages are accepted and adopted into the job ledger once. A Worker
code rollback still leaves D1 data in place; the old version cannot enforce the
new generation checks, so keep consumers paused when reverting across this
migration boundary.

Queue publication failures do not undo accepted jobs. The minute trigger
redispatches the outbox and recovers expired ten-minute leases. Persisted job
attempts cap retries even if an ambiguous send creates another queue delivery.
A job at the attempt limit becomes failed; structured logs include job and run
IDs without credentials or repository file contents.

Inspect durable failures with D1 SQL:

```sql
SELECT id, run_id, repo_full_name, attempts, failure, completed_at
FROM evaluation_jobs WHERE status = 'failed' ORDER BY completed_at DESC;
```

A dashboard Refresh creates a new run to retry after fixing the underlying
issue. Do not reset the aggregate pending counter manually. Reconciliation
repairs it from job state, including counters left by pre-migration messages.
Inspect both dead-letter queues after an ingress/platform outage and replay
failed ingress events with their original delivery IDs. Acknowledged terminal
evaluation jobs remain in D1 for diagnosis and do not automatically enter a DLQ.
