# Architecture

Shipshape is a single-user Cloudflare Worker for checking personal engineering
practices across every repository available through a GitHub App installation.

```text
GitHub App OAuth (identity only)
             |
             v
       owner-gated session ---- KV (short-lived state)
             |
             v
   App installation clients ---- GitHub repositories
             |
             v
       inventory + queue
             |
             v
   bounded snapshot + practice engine
             |
             v
          D1 results
          /       \
   dashboard API   MCP tools
```

## Boundaries

- The dashboard and MCP are available only to the configured owner.
- GitHub App OAuth identifies the owner. The resulting user token is never
  stored or used for repository reads.
- Installation tokens read repository metadata, files, workflows, settings,
  and branch protection according to the App permissions.
- Repository reads use one recursive tree and bounded content reads per
  evaluation. No repository is cloned or executed.
- Practice definitions are strict YAML in the catalog repository. Canonical
  files are compared after line-ending and trailing-whitespace normalization.
- API errors, missing permissions, unavailable features, truncated trees, and
  oversized blobs produce `unknown`, never an inferred pass.

## Runtime flow

GitHub push and installation events, dashboard refreshes, and the daily sweep
enqueue repository evaluations. A consumer loads the catalog, reads the
repository's default-branch head, evaluates each applicable practice, and
stores results in D1. The API and MCP views use the same response builders, so
the dashboard and tools expose the same states and evidence.

## Source layout

- `src/github/` validates GitHub responses and creates authenticated clients.
- `src/inventory/` synchronizes installations and repositories.
- `src/practices/` contains catalog schema, applicability, snapshots, checks,
  workflow parsing, and result views.
- `src/queue.ts` and `src/scheduled.ts` handle asynchronous evaluation.
- `src/api/contract.ts` is the response type source of truth.
- `src/web/` contains the owner login and signed-in placeholder page.

The GitHub App, Cloudflare bindings, migration, and catalog setup are covered
by the setup guide.
