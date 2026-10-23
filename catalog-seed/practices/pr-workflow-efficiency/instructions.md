For pull-request checks, cancel superseded runs and skip jobs while the PR is a
draft. Preserve all existing triggers, filters, permissions, jobs, and conditions.

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  check:
    if: ${{ github.event.pull_request.draft != true }}
    runs-on: ubuntu-latest
    steps:
      # Keep the repository's actual check steps here.
      - run: pnpm test
```

Keep keys stable across commits: use a unique workflow prefix and PR number or
ref, never a commit SHA, run ID, run number, or run attempt. A literal workflow
prefix is also valid. Keep workflow names unique when using `github.workflow`.
Reusable workflows inherit the caller's `github.workflow`; caller and callee
concurrency keys must be distinct to avoid cancelling the caller.

Add `github.event.pull_request.draft != true` to every check job's existing `if`
with `&&`, including reusable-workflow callers and aggregate jobs. For example:
`if: ${{ always() && (needs.test.result != 'cancelled') && github.event.pull_request.draft != true }}`.
Parenthesize existing conditions containing `||` so no branch bypasses the draft
guard. Job guards prevent runner allocation; step guards still allocate runners.
The `!= true` form also permits non-PR events in workflows shared with push or
manual triggers. Preserve failure propagation and cancellation behavior.

Preserve existing activity types when adding `ready_for_review`. If `types` was
implicit, retain the defaults `opened`, `synchronize`, and `reopened`.
Ready-for-review starts checks when review begins.

`converted_to_draft` is optional. Include it only when the repository wants a
replacement run to cancel earlier work as a PR becomes a draft; the job guards
then skip the replacement run's jobs. Without that event, converting to draft
alone does not cancel an existing run.

Concurrency cancellation needs a new run in the same group. If path filters
prevent that run, use a trusted cleanup workflow on PR updates to cancel only
runs for older heads, rechecking the current PR head immediately before
cancellation. Never check out or execute PR code in privileged cleanup. Keep
cleanup permissions narrowly scoped and do not cancel checks for the current
head. Do not add privileged cleanup solely to satisfy a static check.

The evaluator inspects every tracked `.github/workflows/*.yml` and `*.yaml` at
the captured commit. It applies to workflows directly triggered by
`pull_request` and treats every job in those workflows as a check job. Workflows
using only push, schedule, `pull_request_target`, or `workflow_call` are outside
this check's scope. A complete inventory without PR workflows passes.

Passing requires explicit lifecycle events, workflow-level cancellation with a
stable group, and job-level draft exclusion. Simple boolean guards, mandatory
AND guards, and OR branches that all exclude drafts are recognized. Cancellation
may be `true` or conditional on `github.event_name == 'pull_request'`. Complex
expressions, path-filter cleanup, reusable-workflow internals and job-level
concurrency need review and remain unknown. Known violations fail even when
other evidence is unavailable. Malformed/unreadable files and incomplete
inventories remain unknown; the shared 64-file/512-KB read limits apply. The
check never executes repository code or proves that cancellation occurred.

References: [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax),
[PR events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request),
and [reusable workflow concurrency](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations).
