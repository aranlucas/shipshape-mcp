# Architecture

Shipshape is a single-user Cloudflare Worker for checking personal engineering
practices across every repository available through a GitHub App installation.

```text
owner login -- central Auth + GitHub social -- short-lived KV sessions
     |
     v
Hono HTTP router -- dashboard / MCP -- D1 views
     |
GitHub webhook -- verify + await ingress Queue
                              |
                              v
                    inventory / catalog
                              |
manual refresh / daily cron --+-- D1 runs + job outbox
                                      |
minute reconciliation ----------------+-- evaluation Queue
                                                |
                                  bounded GitHub snapshot
                                                |
                                    SQL publication guard
                                                |
                                           D1 results
```

## Boundaries

- The dashboard and MCP are available only to the configured owner.
- Central Auth owns GitHub social login, account linking, consent, and OAuth grants.
  Shipshape verifies the access-token signature, issuer, exact `/mcp` audience,
  `shipshape:access` scope, and linked GitHub claims before comparing `github_id`
  with `OWNER_GITHUB_ID`. GitHub credentials never enter Shipshape's login flow.
- The dashboard uses a public authorization-code client with PKCE and one-time,
  browser-bound state. Its opaque HttpOnly session cookie points to a hashed KV
  record containing identity and expiration. It expires no later than the Auth
  access token; tokens are not stored in dashboard sessions.
- Shipshape publishes protected-resource metadata pointing to Auth's `/api/auth`
  issuer. It exposes no authorization, token, or client registration endpoints.
- Installation tokens read repository metadata, files, workflows, settings,
  and branch protection according to the App permissions.
- Repository reads use one recursive tree and bounded content reads per
  evaluation. No repository is cloned or executed.
- Practice definitions are strict YAML in the catalog repository. Canonical
  files are compared after line-ending and trailing-whitespace normalization.
- API errors, missing permissions, unavailable features, truncated trees, and
  oversized blobs produce `unknown`, never an inferred pass.

## Check semantics and diagnostics

`src/practices/checks.ts` dispatches the parsed `Check` union through an
exhaustive typed switch. Evaluators in `src/practices/checks/` return structured
evidence; `checks/result.ts` adds labels and serializes bounded diagnostics for
storage. Callers use the same `runCheck` interface for every check type.

`repository-files.ts` distinguishes available, missing, and unavailable files.
Only a complete tree without the path proves a file is missing. A known path
without collected content remains unknown. JSON and YAML parsing share this
reader and validate configuration values before evaluators inspect them.

Practice YAML still uses `equals` or `exists` for JSON/YAML paths. Parsing
normalizes these mutually exclusive fields into a typed predicate and converts
the `required_linear_history` compatibility alias to `requiredLinearHistory`.
Branch-protection expectations depend on the key: booleans for flags,
nonnegative integers for `requiredApprovingReviews`, and lists of context names
for `requiredStatusChecks`. Status-check equality compares exact sets, ignoring
order and duplicate names. Incompatible expectation types are validation errors.

Dependency checks require a non-empty declaration in dependencies,
devDependencies, optionalDependencies, or peerDependencies. Omit `version` to
check presence only: `^0.2.2`, `catalog:`, and workspace references all pass.
An explicit `version` retains exact declaration comparison and reports ranges
as unknown rather than inferring a resolved version. Existing presence-only
Oxforge definitions accept a range without catalog changes.

Workflow pinning inspects job-level reusable workflow calls and step-level
Actions, including nested parallel steps. Remote references must use full
commit SHAs; local and Docker references retain their existing exemptions.
Failures include the offending references and their YAML property locations
in the existing bounded `actual` and `detail` fields. Action inputs named
`uses` are not Action references. Dependency review requires one matching
pull-request workflow; token-permission and pinning checks apply to every
workflow.

Evaluations retry transient GitHub server/transport failures with bounded
request retries and an 8-second request timeout. Installation-token reads also
have an 8-second timeout. Rate-limited 403/429 responses defer the repository
until the reset/retry interval; permission failures remain unknown and do not
request retries. Repository/practice jobs share a persisted three-attempt budget.
After a transient evaluation failure, unknown practices can receive independent
delayed jobs without rewriting healthy results. Catalog writes are not replayed
by the evaluation queue.

The starter CI rule checks ci.yml, a declared root test script invoked by CI,
pnpm setup, read-only contents permission,
and that every static CI job name is a required status check on the default
branch. Additional required checks are allowed. Unreadable protection and
dynamic or ambiguous job contexts remain unknown. This uses classic branch
protection reads; ruleset-only requirements are not resolved. The rule does
not verify workflow uniqueness or successful CI execution. The starter
auto-merge rule checks file existence; its pass does not establish safe or
successful merge behavior. Exact file comparisons intentionally report
template differences, including repository-specific additions.

### Built-in practices and the catalog layer

`catalog-seed/practices/` is bundled into the Worker at build time
(`src/practices/built-in-sources.ts`) and parsed as the built-in practices. The
catalog repository is stored in D1 as loaded (its commit, practice folders, and
`disabled` markers) and composed with the bundled set on every read by
`composeCatalog`: a same-id folder overrides a built-in, a marker turns it off,
and other folders are custom practices.

The catalog SHA that stored results carry is `<commit>+<built-in version>`, where
the built-in version hashes the bundled files. A deploy that changes any built-in
therefore makes every stored result stale at once. The first dashboard overview
or MCP request that observes a new built-in version commits the version claim
and repository job intents in one D1 transaction. Concurrent observers create
one refresh run; a failed queue send leaves recoverable job intents. The daily
sweep also revalidates every repository. Apply all migrations before deploying;
the standard release script applies them automatically.

### Refreshing stored results

The owner dashboard's Refresh action revalidates each repository's current
default-branch head. Manual refreshes, pushes, catalog events, and daily sweeps
reuse healthy file-practice results when their head SHA, catalog SHA, and
evaluation key match. Cached evidence and its original `checkedAt` are preserved;
the sweep completion time records completion of the revalidation.

Reuse is decided per practice. Missing, unknown, retrying, and incomplete results
are recomputed without rewriting other healthy results. Practices containing
settings, branch-protection, or CI required-check checks are always evaluated
because these settings can change without a commit. Snapshots for settings-only
and protection-only practices skip the repository tree unless applicability
requires files. Installation events still force evaluation to verify permissions.

The evaluation key includes repository metadata used by applicability and an
evaluator version. Bump `EVALUATOR_VERSION` in
`src/practices/evaluation-key.ts` whenever evaluator semantics change, then use
Refresh to replace stored evidence. Existing rows without the key are recomputed
on their next evaluation. Apply `0003_evaluation_key.sql` before deploying this
code; the standard deploy script applies migrations automatically. The read-only
MCP tools use stored results; request maintenance can enqueue a built-in refresh.

### Sharing GitHub inputs between practices

Practices in one evaluation share a single repository snapshot. Separate practice
deliveries and later evaluations also share a D1 cache of complete Git trees and
successfully decoded file contents. Entries are scoped by installation,
repository, commit SHA, and resource path, so a new commit fetches its own data.
Catalog or evaluator changes can recompute results using the same immutable
inputs without downloading them again.

The default-branch head, repository settings, and branch protection are read live.
Forced evaluations, including installation events, bypass cached inputs. Failed
reads, truncated trees, and oversized files are not cached; an unavailable or
malformed cache falls back to GitHub. Each cached JSON payload is limited to
512 KiB, entries expire after seven days, and the daily sweep removes expired
entries. Existing snapshot read budgets still apply.

Apply `0004_github_snapshot_cache.sql` before deploying these changes; the standard
deploy script applies it automatically. Concurrent evaluations that encounter a
cold cache may both fetch the same input before either has stored it.

## Durable work and result publication

The top-level HTTP router uses Hono. `/github/webhook` verifies the signature,
projects the event into a compact envelope, and awaits `WEBHOOKS.send` before
returning `202`. A failed send returns `503`; inventory/catalog reads happen in
the ingress consumer. GitHub delivery IDs identify refresh runs. A digest of the
signed event is used only when the delivery header is absent. Duplicate events
reuse the same persisted run. Installation events re-evaluate the refreshed
inventory so a retry after inventory synchronization cannot lose its targets.

All evaluation triggers write `evaluation_runs`, `evaluation_heads`, and
`evaluation_jobs` in a D1 transaction. The latest run for each repository is its
generation. Jobs double as an outbox: publishing them is separate from accepting
work. A failed/ambiguous queue send can repeat, but always uses the same job ID.
The minute cron reconciles unpublished or overdue deliveries and expired leases.
A lease lasts ten minutes; an overdue publication is redispatched after its
scheduled availability plus ten minutes. The queue is capped at one concurrent
consumer invocation, with three repository evaluations inside a batch.

A consumer claims a job atomically and uses its stored metadata rather than the
message's repository fields. Results, unknown-state writes, retry flags, and
cleanup check the lease and latest repository generation in SQL. Evaluation
writes also check the catalog commit. A superseded run, removed installation,
or expired lease cannot publish results over current evidence. Practice retry
jobs inherit the parent run and attempt budget; their creation and parent
completion are transactional.

The existing `sweep` response remains compatible, but its pending value is a
projection of active job states. Database triggers update it only when jobs are
inserted or change state, so a repeated completion cannot decrement twice.
Each run records completion independently. Terminal errors are persisted on
the job with a bounded failure description and logged with job/run/repository
identifiers. Expected GitHub permission failures still produce unknown evidence.
Unexpected platform delivery failures use configured dead-letter queues; jobs
that deliberately enter a terminal state are acknowledged after persistence.

The daily 13:00 UTC cron refreshes inventory/catalog and requests a sweep. The
minute cron repairs job dispatch and leases without triggering another sweep.
Old evaluation messages without job IDs are adopted into stable legacy runs.

Dashboard and MCP views use the same response builders. Overview/count queries
select cell summaries without downloading or parsing detailed `checks_json`;
repository detail reads retain the full evidence. The dashboard still polls
while work is active.

Previews require separate D1 and OAuth KV IDs, use preview queue names, and
reject dashboard mutations and webhooks. They have no queue/cron consumers.
Preview resources and migration commands are described in the setup guide.

## Source layout

- `src/github/` validates GitHub responses and creates authenticated clients.
- `src/inventory/` synchronizes installations and repositories.
- `src/practices/` contains catalog schema, applicability, snapshots, checks,
  workflow parsing, and result views.
- `src/jobs/` owns durable runs, leases, dispatch, and SQL write guards.
- `src/queue.ts` and `src/scheduled.ts` handle asynchronous evaluation.
- `src/github/webhook-route.ts` accepts signed events; `events.ts` consumes them.
- [`src/api/contract.ts`](../src/api/contract.ts) is the response type source of
  truth for both the dashboard API and MCP tools.
- `src/web/` contains the owner login and signed-in placeholder page.

The GitHub App, Cloudflare bindings, migration, and catalog setup are covered
by the setup guide.
