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
Exhausted transient reads remain unknown and request a delayed retry of that
repository's queue message. Installation-token HTTP 5xx failures also request a
delayed retry. These failures allow at most three evaluation deliveries, with
60 s and 120 s delays;
pending bookkeeping completes on recovery or the final delivery. Persistent
failures remain unknown for the next sweep or manual refresh. Permission and
feature errors do not request queue retries. Catalog writes are not replayed,
and these retries do not trigger additional sweeps.

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
MCP tools do not trigger refreshes.

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
