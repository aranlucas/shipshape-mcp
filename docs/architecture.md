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

Evaluations retry transient GitHub server/transport failures at most twice,
with 250 ms and 1 s backoffs and the existing 8 s per-request timeout.
HTTP 4xx responses, including permission and feature errors, are not retried.
Exhausted reads remain unknown. These retries do not change catalog-write
behavior or trigger additional sweeps.

The starter CI rule checks ci.yml, pnpm setup, read-only contents permission,
and that every static CI job name is a required status check on the default
branch. Additional required checks are allowed. Unreadable protection and
dynamic or ambiguous job contexts remain unknown. This uses classic branch
protection reads; ruleset-only requirements are not resolved. The rule does
not verify workflow uniqueness or successful CI execution. The starter
auto-merge rule checks file existence; its pass does not establish safe or
successful merge behavior. Exact file comparisons intentionally report
template differences, including repository-specific additions.

### Refreshing stored results

Deploying an evaluator change does not replace stored results. Use the owner
dashboard's Refresh action to enqueue fresh evaluations, then confirm that
`repo_practices` reports a declared Oxforge range as pass for the existing
presence-only dependency check. The read-only MCP tools do not trigger refreshes.

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
- [`src/api/contract.ts`](../src/api/contract.ts) is the response type source of
  truth for both the dashboard API and MCP tools.
- `src/web/` contains the owner login and signed-in placeholder page.

The GitHub App, Cloudflare bindings, migration, and catalog setup are covered
by the setup guide.
