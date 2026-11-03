# Cloudflare architecture decisions

The 2026-10-17 assessment led to durable jobs, ingress queue acceptance, SQL
publication guards, isolated previews, and summary queries. The
[current architecture](../architecture.md) describes those implemented boundaries.

Keep the single Worker, Static Assets, D1, Queues, and stateless MCP transport.
They fit the single-owner service: D1 supports portfolio queries, Queues buffer
repository evaluations, and MCP reads stored results without conversational state.
Stable job IDs, a transactional outbox, and generation guards address duplicate
delivery and stale publication without adding another coordination service.

Further infrastructure needs measurements, not a new default stack:

| Candidate        | Adopt when                                                                                           | Boundary to preserve                                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflows        | Sweeps need resumable orchestration and explicit parent-run progress                                 | Keep Queues for fan-out; queue sends and database effects still need idempotency. A parent dispatch is complete only after observing child jobs. Pass IDs rather than snapshots between steps. |
| Durable Objects  | GitHub installation rate limits or duplicate token refreshes require shared admission/cooldown state | Coordinate per installation, with all relevant callers participating; keep portfolio queries in D1.                                                                                            |
| R2               | Measured immutable cache bytes and writes make D1 storage a material cost                            | Preserve installation/repository/commit isolation, forced-read bypass, validation, and read budgets.                                                                                           |
| Analytics Engine | Aggregate duration, retry, unknown-rate, and cache trends justify a separate store                   | Job completion and results remain authoritative in D1.                                                                                                                                         |

Retain polling until progress correctness and query cost justify a live-update
service. Workers Cache is not a drop-in replacement for the shared snapshot
cache across queue and scheduled handlers.

These are conditional design options, not release commitments or cost estimates.
The assessment did not inspect production traffic, billing, or account metrics.

Provider references: [Queue delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/),
[Workflow rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/),
[Durable Object design](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/),
[Workers Cache limitations](https://developers.cloudflare.com/workers/cache/limitations/).
