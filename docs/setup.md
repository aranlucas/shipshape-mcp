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
- Callback URL: `${PUBLIC_ORIGIN}/callback`.
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

After creating the App, save its App ID, Client ID, and Client Secret. Generate
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

Create the D1 database and queue:

```sh
cf d1 create --name shipshape
cf queues create --queue-name shipshape-evaluations
```

The Worker configuration already declares the `DB` binding for the `shipshape`
database and the `EVALUATIONS` binding for the `shipshape-evaluations` queue.
If you manage queue consumers explicitly, create the Worker consumer with a
batch size of five:

```sh
cf queues consumers create <QUEUE_ID> \
  --script-name shipshape-mcp \
  --type worker \
  --settings-batch-size 5
```

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
export GITHUB_APP_CLIENT_ID=<client-id>
export OWNER_GITHUB_ID=<numeric-owner-id>
```

Set the secret bindings with the installed CLI. Keep the values in local shell
variables or a password manager and never paste real values into this guide or
the repository:

```sh
export GITHUB_APP_PRIVATE_KEY="$(<app.pkcs8.pem)"
export GITHUB_APP_CLIENT_SECRET=<client-secret>
export GITHUB_WEBHOOK_SECRET=<webhook-secret>
export COOKIE_ENCRYPTION_KEY=<random-cookie-key>

cf workers secrets update GITHUB_APP_PRIVATE_KEY --worker shipshape-mcp --text "$GITHUB_APP_PRIVATE_KEY"
cf workers secrets update GITHUB_APP_CLIENT_SECRET --worker shipshape-mcp --text "$GITHUB_APP_CLIENT_SECRET"
cf workers secrets update GITHUB_WEBHOOK_SECRET --worker shipshape-mcp --text "$GITHUB_WEBHOOK_SECRET"
cf workers secrets update COOKIE_ENCRYPTION_KEY --worker shipshape-mcp --text "$COOKIE_ENCRYPTION_KEY"
```

`CATALOG_REPO` is configured as a text binding and defaults to
`aranlucas/practices`. Set `CATALOG_REPO=owner/name` in the deployment
environment before building or deploying when the catalog repository moves.
The catalog lookup and write allowlist compare repository names
case-insensitively; keep the configured value aligned with an installed
repository.
`PUBLIC_ORIGIN` is the deployed Worker origin and is used to build the OAuth
callback and webhook URLs.

Secrets must be configured on the production Worker as well as on any Preview.
A successful Preview deployment does not configure production credentials.
To upload the App secrets together with a production deployment, put them in a
protected JSON file outside the repository and use:

```sh
pnpm build
pnpm run deploy:ci --secrets-file /secure/path/app-secrets.json
```

Use `pnpm run deploy` for a local production release, or `pnpm run deploy:ci`
after `pnpm build`. Both apply pending D1 migrations before uploading the Worker
and stop if a migration fails. The database ID comes from the built Worker's
`DB` binding, so it stays aligned with the deployed artifact. Prebuilt output
must use production mode; Preview output is refused. `pnpm dry-run` builds and
checks the same artifact without applying migrations or uploading anything.

Workers Builds uses `pnpm run build` followed by `pnpm run deploy`; keep its
deploy command on the package script so it receives the migration gate.
Direct `cf deploy` calls bypass that gate. The build token needs D1 edit access
for the bound database as well as Worker deployment access. Forward a named
CLI auth profile with `--profile <name>` when needed; both migration and upload
use it. Changes to an existing schema must remain compatible with the currently
running Worker because migrations run before the new code is uploaded.

After deployment, sign in and choose **Find my repositories**. On an empty
database this imports the App's installed repositories, loads the catalog,
and queues their first checks. The production queue consumer must be deployed
for those checks to complete; a Preview alone cannot process them.

## 5. Create and seed the private catalog repository

Create the private repository and push the contents of `catalog-seed/` under a
top-level `practices/` directory. These commands are documentation only; do
not run them against a real account without reviewing the target first:

```sh
gh repo create aranlucas/practices --private
git clone git@github.com:aranlucas/practices.git /tmp/aranlucas-practices
rsync -a catalog-seed/ /tmp/aranlucas-practices/
cd /tmp/aranlucas-practices
git add practices
git commit -m "seed: add personal practices"
git push origin main
```

The catalog layout is `practices/<id>/practice.yml`, with optional
`instructions.md` and `files/` content. The dashboard can later edit or retire
practices through the API; each write is validated and committed only to this
allowlisted catalog repository.

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
`GITHUB_APP_CLIENT_ID`, and `OWNER_GITHUB_ID` are read from `process.env` by
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

Before opening the dashboard, verify that the App callback and webhook URLs
use the same `PUBLIC_ORIGIN` shown by the local server. Local D1 and Queue
simulations are safe for development; use the configured Cloudflare resources
only when you intentionally test the deployed integration.

## 7. Branch previews

`pnpm preview` builds and deploys the current branch without queue consumers
or cron triggers, which Cloudflare Previews do not support. The dashboard
login and MCP discovery use the incoming Preview origin. Add its exact
`https://<preview-host>/callback` URL to the GitHub App's callback URLs before
testing sign-in.

Preview secrets are separate from production secrets. Upload a protected JSON
file containing `GITHUB_APP_PRIVATE_KEY` (PKCS#8),
`GITHUB_APP_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`, and
`COOKIE_ENCRYPTION_KEY` using Wrangler's Preview secret command. The installed
`cf` version does not expose this command; Wrangler `4.151.0` is also present
as a transitive dependency, or can be invoked explicitly:

```sh
npx wrangler@4.151.0 preview secret bulk /secure/path/preview-secrets.json \
  --worker-name shipshape-mcp --name '<branch-name>'
```

This updates only the named Preview deployment. Do not use a production
`workers secrets` command when the intended target is a Preview.

The current bindings point to the `shipshape` D1 database by its explicit ID,
`shipshape-evaluations` queue, and OAuth KV namespace. These resources are
shared with production. A Preview can enqueue checks, but cannot consume them;
without a deployed consumer, checks remain pending. Use local D1 and Queue
simulation to verify the full evaluation flow before production is enabled.
Keep Preview catalog writes within the intended private catalog repository.
