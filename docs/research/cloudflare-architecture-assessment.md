# Cloudflare architecture assessment

Assessment date: 2026-10-17. Scope: repository code, configuration, migrations,
and tests, checked against current Cloudflare documentation. This is an
architecture investigation recorded before implementation; no deployed resources
were changed. The follow-up implements durable jobs, ingress queue acceptance,
SQL result guards, isolated read-only previews, and summary projections. See
[the current architecture](../architecture.md) and [rollout instructions](../setup.md). Production traffic, account settings, billing, and resource metrics
were not inspected.

## Recommendation

Keep the single Worker, Static Assets, D1, Queues, and stateless MCP transport.
They fit this single-owner portfolio service. Improve durable job acceptance,
idempotency, and result ordering before adding services.

**Workflows is the best next primitive** if sweeps need resumable orchestration
and explicit run status. **Durable Objects is a conditional addition** for
coordination around each GitHub installation. **R2 is a storage option** if
immutable snapshot payloads become a material D1 workload. None of these
automatically fixes the existing consistency gaps.

## Architecture today

| Boundary        | Implementation and responsibility                                                                                                                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment      | One Worker exports HTTP, queue, and scheduled handlers in [src/index.ts](../../src/index.ts). Configuration uses `cf@1.0.0-beta.17` and `cloudflare.config.ts`, rather than a Wrangler configuration.                                                                      |
| Dashboard       | Preact, TanStack Query, and a separate Vite UI build. Workers Static Assets serves the bundle; the Worker checks the session for the HTML shell and API. Hashed bundles are public.                                                                                        |
| Identity        | GitHub OAuth identifies the configured owner. KV stores OAuth/provider state, web sessions, and cached installation tokens. Repository access uses GitHub App installation tokens.                                                                                         |
| Read interfaces | Hono dashboard API and three stateless MCP tools share [response builders](../../src/practices/views.ts) and [types](../../src/api/contract.ts).                                                                                                                           |
| Triggers        | Default-branch pushes, installation/repository events, dashboard refreshes, catalog changes, and a daily cron at 13:00 UTC request evaluations.                                                                                                                            |
| Background work | One evaluation queue, batches of five, and a `p-limit(3)` inside each batch. Transient reads have bounded request retries; some failures fan out into delayed per-practice messages.                                                                                       |
| Evaluation      | Read the current default-branch head, collect one bounded snapshot, evaluate applicable practices, and upsert results. Healthy immutable checks can reuse existing results. Settings and branch protection are read live. Repository code is never executed.               |
| Catalog         | Built-ins from `catalog-seed/practices/` are bundled into the Worker. The GitHub catalog supplies overrides, additions, and disabled markers; D1 stores that layer and `composeCatalog` derives the effective set. Results carry the catalog commit plus built-in version. |
| Persistence     | D1 stores repositories, the catalog layer, the latest result per repository/practice, shared pending bookkeeping, and an immutable GitHub input cache. Cache entries expire after seven days and are capped at 512 KiB each.                                               |
| Observability   | Worker invocation logs and tracing are already enabled. Application job failures have little structured context.                                                                                                                                                           |

This has useful boundaries: one contract for dashboard and MCP, explicit
`unknown` results for incomplete evidence, bounded external reads, and a
versioned catalog. Keeping evaluation out of the read path makes stored results
available even when GitHub is slow. MCP requests can still schedule maintenance
through the built-in version check; individual read tools do not refresh GitHub.

## Priority findings

### 1. Webhook acceptance precedes durable work acceptance

[src/index.ts](../../src/index.ts), `handleWebhook`, returns `202` after putting
`handleWebhookWork` into `ctx.waitUntil`. That background work can refresh the
installation inventory or catalog before publishing evaluations. There is no
durable inbox or use of `X-GitHub-Delivery` as an application idempotency key.

A background failure therefore happens after GitHub has received a successful
HTTP response. HTTP `waitUntil` has a 30-second extension after invocation end;
it is not a durable job executor. [Cloudflare context documentation](https://developers.cloudflare.com/workers/runtime-apis/context/)

**Change:** validate the signature and relevant payload, project it into a small
event envelope, and **await an ingress Queue send before returning `202`**.
Carry the delivery ID through processing and use it to identify duplicate work.
Keep inventory/catalog refreshes in the consumer. Do not put the entire allowed
5 MiB request body into a queue message. A second queue separates ingress from
repository evaluation without requiring a second Worker deployment.

### 2. Progress bookkeeping is not idempotent

[src/queue.ts](../../src/queue.ts), `enqueueRepositories`, increments one shared
counter before sending messages. [src/practices/store.ts](../../src/practices/store.ts),
`completePendingMessage`, decrements it on every completion, without identifying
the job. Compensation handles caught publish failures, but not termination
between the database write and queue send, or ambiguity after a successful send.

Queues uses at-least-once delivery. Duplicate delivery is a supported condition,
not an exceptional contract violation. [Queue delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)

**Confirmed with the existing SQL:** start with jobs A and B pending. Completing
A produces `pending=1`. Completing duplicate A produces `pending=0` and sets
`last_completed_at`, although B has not completed. The dashboard can stop polling
because it trusts this state.

**Change:** introduce stable application job IDs and a D1 job ledger. Record
terminal state with a conditional transition so completion occurs once per job.
Derive run progress from job states, or update an aggregate only when the
transition changes a row. Track runs separately rather than treating pushes,
manual refreshes, and daily sweeps as one shared counter.

For reliable fan-out, persist job intents and outbox rows in the same D1 batch
transaction. A publisher sends them to Queues and marks dispatch afterward;
reconciliation retries undispatched intents. A crash can still duplicate a
send, which the stable job ID makes harmless. D1 and Queues do not share a
transaction.

### 3. Older evaluations can replace newer results

[src/practices/evaluate.ts](../../src/practices/evaluate.ts) reads the head and
catalog at evaluation start. The result upsert in
[src/practices/store.ts](../../src/practices/store.ts), `writeResultInputs`,
unconditionally replaces the existing row. There is no generation guard.

**Confirmed with the existing SQL:** an evaluation for a new head commits,
then an older evaluation finishes and writes its old head into the same row.
The later completion timestamp does not establish that the GitHub inputs were
newer. A similar overlap across catalog changes can replace visible results
with an old catalog version that the views subsequently hide.

**Change:** allocate a monotonic desired generation per repository in D1 and
carry it in the job and practice retries. Guard result writes, retry flags,
and result cleanup against that generation and the intended catalog version.
Superseded jobs may complete their own ledger entry without publishing results.
Do not order Git SHAs lexically or rely on check completion timestamps.

Per-repository Durable Objects could serialize evaluation, but D1 generation
checks are the smaller initial fix and remain useful if orchestration changes.

### 4. Built-in invalidation can lose its refresh

`requeueIfBuiltInsChanged` claims the new built-in version in D1 before listing
repositories and enqueueing them. After a publish failure, later callers observe
the claim and do not retry the refresh. A subsequent daily sweep can repair the
state, but the claim alone does not establish durable fan-out.

**Confirmed with the existing SQL:** the first claim changes one row; the
second changes zero rows even if publication after the first claim failed.

**Change:** persist the version transition and refresh intents together. The
outbox/job-ledger design above gives this a recovery path. Merely moving the
claim after publication creates a different duplicate/race window.

### 5. Concurrency limits do not coordinate the GitHub installation

The consumer limits three repository evaluations per batch; snapshots can issue
eight concurrent file reads each. That allows up to 24 file-read tasks within
one batch invocation, plus other requests. Multiple consumer invocations can
run concurrently. The checked-in queue trigger sets batch size but no maximum
consumer concurrency. Cloudflare explicitly supports a consumer concurrency cap
when an upstream API is the limiting resource. [Consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/)

Evaluation clients disable Octokit throttling. Current retry classification
does not request delayed evaluation retries for rate-limited 403/429 responses;
the tests explicitly cover no retry for these statuses.

**Change first:** set an explicit consumer concurrency budget and distinguish
rate-limit responses from permission failures using headers and response data.
Honor reset/retry timing through delayed delivery. A cap limits simultaneous
work; it is not an hourly quota limiter.

If multiple installations or producers need independent budgets, use one
Durable Object per installation for cooldown state, bounded admission, and
single-flight token refresh. All relevant GitHub callers must participate for
this to control their combined demand. This adds RPC and admission/lease logic;
measure rate-limit frequency and duplicate token minting before adopting it.

### 6. Previews share production resources

[cloudflare.config.ts](../../cloudflare.config.ts) removes queue/cron triggers
for previews, but retains the production D1 ID, OAuth KV ID, queue name, and
catalog configuration. [docs/setup.md](../setup.md) explicitly documents the
sharing. A preview refresh can enqueue work for the production consumer; a
preview editor can also write the configured GitHub catalog if its credentials
permit it.

**Change:** bind previews to separate D1, KV, and queue resources, and use a
separate catalog repository/credentials or disable catalog writes. Apply
migrations to the preview database explicitly. Preview deployments do not make
arbitrary bindings isolated automatically. [Preview resource isolation](https://developers.cloudflare.com/workers/previews/resources/)

### 7. Terminal failures need durable diagnostics

The final exception path in `handleMessage` acknowledges a failed evaluation
after decrementing pending, without recording the cause. No DLQ is declared in
the checked-in trigger. A DLQ alone would not catch these explicitly acknowledged
messages: automatic DLQ routing happens after retries are exhausted.
[Dead-letter queue behavior](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)

**Change:** record terminal job status and a bounded failure category; emit
structured logs with job/run/repository/attempt identifiers. Keep expected
permission failures as `unknown` evidence. For unexpected operational failures,
either let configured retries exhaust into a DLQ or explicitly persist a failed
job before acknowledging. Align application delivery budgets and platform retry
settings. Reconcile abandoned jobs so progress cannot remain stuck forever.

## Where additional primitives fit

| Primitive           | Decision                                 | Specific role and tradeoff                                                                                                                                                                                                                                      |
| ------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflows           | Best next addition after job correctness | Coordinate a sweep: refresh inventory, load catalog, persist run/jobs, dispatch evaluations, wait/reconcile terminal jobs, finalize the run. Successful steps can be reused after interruption. Keep Queues for repository fan-out and burst buffering.         |
| Durable Objects     | Conditional                              | Coordinate GitHub admission/cooldowns and token refresh per installation. Use a repository object only if repository serialization becomes a central requirement. Keep portfolio queries in D1.                                                                 |
| R2                  | Conditional                              | Store immutable tree/file payloads if D1 cache bytes and writes dominate. Keep inventory, result metadata, and jobs in D1. Preserve installation/repository/SHA isolation, bypass on forced evaluation, validation, read budgets, and fail-open cache behavior. |
| Workers Logs/Traces | Improve existing integration now         | Add structured failure and duration events, cache hit/miss counts, GitHub request counts, and rate-limit categories. Existing configuration already enables logs and sampled traces.                                                                            |
| Analytics Engine    | Later if aggregate trends are needed     | Track duration, retries, unknown rates, and cache effectiveness across many runs. It should not become the authoritative store for job completion or results.                                                                                                   |
| Workers Cache       | Not a drop-in snapshot-store replacement | The automatic Workers Cache integration excludes queue, cron, and Workflow execution. The shared input cache must work across those execution paths.                                                                                                            |
| Stateful Agents/MCP | No current requirement                   | The MCP tools read stored results and do not need conversational state or persistent sessions. Adding a stateful agent layer would add another lifecycle without solving the identified job gaps.                                                               |

Workflow boundaries should be durable orchestration steps, not one step per
pure check. Steps can retry, so GitHub writes, queue sends, and database effects
still need idempotency. Completed parent dispatch does not mean child jobs
finished: explicitly observe the job ledger before finalizing. [Workflow rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)

Pass IDs and small metadata between steps. A normal non-stream step result is
limited to 1 MiB, and one repository snapshot can contain many 512 KiB inputs;
persist large inputs separately rather than serializing the snapshot through a
step result. [Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/)

Workflows bills requests, CPU, steps, and retained storage. A small orchestration
Workflow is easier to justify than a Workflow step for every file or check. No
cost estimate is defensible without repository count, event volume, measured
payload sizes, and the account plan. [Workflow pricing](https://developers.cloudflare.com/workflows/reference/pricing/)

Durable Objects should follow the actual coordination boundary; a single global
object for all HTTP requests would create unnecessary coupling.
[Durable Object design guidance](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)

R2 supplies object storage and Workers bindings, but this repository has no
measured storage pressure yet. Retain the D1 cache until measurements justify
the extra resource and cache migration. [R2 architecture](https://developers.cloudflare.com/r2/how-r2-works/)

Automatic caching of Worker entrypoints does not cover the background handlers
used here. A separate cached HTTP/RPC path would need an explicit design and
would remain an optimization rather than a durable job mechanism.
[Workers Cache limitations](https://developers.cloudflare.com/workers/cache/limitations/)

## Smaller improvements before infrastructure expansion

- Give overview reads a summary projection. `buildOverview` reads every
  `checks_json` payload through `readResults` and parses detailed evidence that
  the overview discards. Read cell fields for overview/counts and load detailed
  checks only for repository detail. This reduces D1 result transfer and Worker
  parsing while preserving the API contract.
- Keep the current three-second polling for a single owner initially. Reliable
  progress and smaller queries matter more than introducing a live-update
  Durable Object or WebSockets.
- Treat KV as a cache/distribution store, not a one-time consumption primitive.
  OAuth and web login state consumption use separate `get` and `delete` calls;
  this does not provide atomic consume-once semantics. If strict one-time use
  and immediate invalidation are required, store the custom login/consent state
  in D1 and consume it atomically after validating its browser binding. The
  provider library's own persistence is a separate integration decision. This
  is a consistency observation, not a demonstrated authentication bypass.
  [KV consistency guidance](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

## Implementation sequence

1. Isolate preview resources and catalog writes.
2. Add stable jobs/runs, idempotent completion, repository generations, and a
   transactional outbox. Include built-in invalidation in the same design.
3. Add durable webhook ingress, explicit queue concurrency/retry/DLQ policy,
   structured diagnostics, and abandoned-job reconciliation.
4. Reduce overview queries and collect real duration, API-call, cache-size,
   and retry measurements.
5. Adopt one Workflow per sweep/refresh run if resumability and orchestration
   visibility justify it. Add installation Durable Objects or R2 only when the
   measured coordination/storage needs warrant them.

Stay on `cloudflare.config.ts` and the existing CLI. Before implementation,
verify the exact binding/trigger builder APIs in the pinned `cf` package rather
than copying Wrangler configuration keys into it.

## Investigation verification and limits

Read the deployment configuration, entrypoints, API/MCP views, inventory sync,
catalog composition, evaluator, GitHub client/cache, authentication storage,
schema migrations, UI polling, and the relevant Worker tests.

Applied all five checked-in migrations to an in-memory SQLite database and
executed SQL extracted from the current implementation. Results:

```text
After job A completes: pending=1, last_completed_at=NULL
After duplicate A completes while B is unfinished: pending=0, completion set
After newer evaluation commits and older finishes: stored head=old-head
Built-in version claim changes: first=1, next=0, even if enqueue failed
```

These establish local algorithmic failure scenarios; they do not demonstrate
that production has experienced them. SQLite was used to check the actual SQL,
not to simulate Cloudflare scheduling or network delivery. During the initial investigation, the full application
test suite was not run: this checkout has no installed `node_modules`, and no
runtime code was changed. Before shipping a fix, add Worker integration tests
for duplicate delivery, stale generations, termination around dispatch,
partial retry fan-out, and failure after a built-in version transition.
