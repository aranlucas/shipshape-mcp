# Security policy

Shipshape is a single-owner service. The configured GitHub user may sign in to
the dashboard and authorize MCP access; every other GitHub account is rejected.
Central Auth owns GitHub social sign-in and explicit account linking at
`https://auth.aranlucas.workers.dev/account`. Shipshape accepts only signed,
resource-bound `shipshape:access` JWTs from the configured Auth issuer, with
GitHub identity claims matching `OWNER_GITHUB_ID`. Dashboard code exchanges use
PKCE and browser-bound state; local sessions expire with the issued access
token. Existing Shipshape OAuth grants must be replaced by reconnecting clients.

Repository access comes from a GitHub App installed on the owner's personal and
organization accounts, so the service can evaluate private repositories without
using a long-lived user token.

The Worker reads repository metadata, files, workflows, settings, and branch
protection through installation tokens. It takes bounded snapshots at a
repository's default-branch commit; it does not clone repositories or execute
repository code. Results are stored in D1 and evaluation work is delivered by a
Cloudflare Queue.

The dashboard can write practice definitions, but the GitHub App's Contents
write capability is restricted in application code to the configured private
catalog repository (`CATALOG_REPO`, normally `aranlucas/practices`). The Worker
does not write to evaluated repositories. Fix requests remain disabled and are
shown as “coming soon” until their separate sub-project is implemented.

Please report vulnerabilities through GitHub's private vulnerability reporting
flow for this repository. Do not include active credentials in a public issue.

Useful reports include:

- owner-gate, OAuth redirect, consent, session, state, or CSRF bypasses;
- cross-account or cross-repository data exposure;
- a path that bypasses the catalog write allowlist or mutates an evaluated repository;
- webhook signature bypasses or unsafe handling of GitHub App credentials;
- server-side request forgery, unsafe client-metadata rendering, or code execution.

The supported deployment is the current `main` branch on Cloudflare Workers.
Security fixes are prioritized over feature compatibility.
