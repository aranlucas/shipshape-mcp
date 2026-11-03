# Architecture

Shipshape keeps GitHub evaluation out of the dashboard and MCP read path so
stored results remain available when GitHub is slow. Both interfaces share the
[response contract](../src/api/contract.ts) and
[view builders](../src/practices/views.ts). Authentication and the catalog write
boundary are specified in [SECURITY.md](../SECURITY.md).

```text
signed webhook -- await ingress Queue -- inventory / catalog
                                                |
manual refresh / daily sweep -------------------+-- D1 run + job intents
                                                          |
minute reconciliation --------------------------+-- evaluation Queue
                                                          |
                                                bounded GitHub snapshot
                                                          |
                                                SQL publication guard
                                                          |
                                                     D1 results
                                                          |
                                                  dashboard / MCP
```

## Evidence and result states

An evaluation captures the default-branch commit and reads a bounded tree and
file snapshot without cloning or executing repository code. A missing path is
proven only by a complete tree; a known but unread file is unavailable evidence.
Any definite check failure makes the practice fail; otherwise any unavailable
check makes it unknown. Applicability exclusions produce `not_applicable`.

Passing static checks establishes only the evidence inspected, not successful
execution of CI, tests, hooks, or deployment. See [coverage gaps](practice-coverage.md)
and the bundled practice instructions for specific limits. Schema and supported
options live in [schema.ts](../src/practices/schema.ts); examples live in
[`catalog-seed/practices/`](../catalog-seed/practices).

## Catalog versions and invalidation

The [catalog setup guide](setup.md#5-create-the-private-catalog-repository)
describes built-in, override, custom, and disabled practices. D1 stores the
catalog repository's layer; reads compose it with the currently deployed
built-ins. Stored results carry `<catalog commit>+<built-in version>`.
Changing any bundled practice file changes that version, making old results stale.

The first dashboard overview or MCP request observing a new built-in version
commits its version claim and refresh intents in one D1 transaction. Concurrent
observers create one run. Failed queue publication leaves recoverable intents;
the daily sweep also revalidates the portfolio.

Refresh rechecks each repository's head but reuses healthy immutable evidence
when head, catalog version, and evaluation key match. It preserves the original
`checkedAt`; sweep completion means revalidation finished, not that every file
was downloaded again. Missing, unknown, retrying, and incomplete results are
recomputed per practice. Settings, branch protection, and required CI checks
are refreshed even without a new commit because they can change independently.
Installation events force evaluation to recheck permissions.

Bump `EVALUATOR_VERSION` in
[evaluation-key.ts](../src/practices/evaluation-key.ts) whenever evaluator
semantics change, then use Refresh to replace stored evidence.

## Immutable input cache

Practices share a snapshot. Separate deliveries can reuse complete Git trees
and successfully decoded files from D1, scoped by installation, repository,
commit, and path. Catalog or evaluator changes can reuse those immutable inputs;
head, settings, and protection reads stay live. Forced evaluations bypass the cache.
Failed reads, truncated trees, and oversized files are not cached. Cache failure
falls back to GitHub, and snapshot read budgets still apply. Concurrent cold
reads may fetch the same input before either stores it.

## Durable work and publication

Webhook signature and payload validation precede acceptance. The HTTP handler
awaits a compact ingress Queue message before returning `202`; failed publication
returns `503`. Inventory and catalog reads happen in the consumer. GitHub delivery
IDs identify runs, with a signed-event digest as fallback, so duplicate events
reuse persisted work.

D1 run/job creation is transactional. Jobs double as an outbox because D1 and
Queues share no transaction. Publication can repeat after an ambiguous send,
but always carries the stable job ID. The minute trigger redispatches overdue
work and recovers expired leases.

Consumers claim jobs atomically and use persisted metadata rather than message
repository fields. SQL guards check lease ownership, latest repository generation,
installation, and catalog commit before publishing evidence. Superseded runs and
expired leases cannot overwrite current results. Per-practice retries inherit
the parent's run and attempt budget; creation and parent completion are transactional.

Progress derives from job states. Repeated completion cannot decrement pending
twice, and each run completes independently. Terminal failures remain in D1 with
bounded diagnostics; deliberately terminal jobs are acknowledged and may never
enter a dead-letter queue. See [rollout and recovery](setup.md#8-durable-job-rollout-and-recovery)
for consumer pausing, failed-job queries, and replay guidance.

[Deployment configuration](../cloudflare.config.ts) owns concurrency, retries,
queues, and cron schedules. [Setup](setup.md#7-branch-previews) covers the separate,
read-only preview resources. [Architecture decisions](research/cloudflare-architecture-assessment.md)
explain why the service retains this topology and what would justify expansion.
