# Shipshape feature roadmap

Updated 2026-10-26. Proposed release order, not delivery dates or evidence of customer demand. Targets below are pilot decision gates, not measured results.

## User and outcome

A maintainer with many repositories who needs to know which few changes are worth doing next and whether they actually helped.

## Current baseline

Shipshape already inventories GitHub repositories, evaluates a practice catalog and exposes overview/detail tools plus a dashboard. Results distinguish pass, fail, unknown and not applicable.

Planning evidence: [README](README.md) and [MCP entry point](src/mcp.ts) at `1561668ce157`. This focused product pass does not claim a complete new code audit or live-provider validation.

## Prioritized releases

| Order | Feature                                   | User value and scope                                                                                                                                      | Release acceptance                                                                                                            |
| ----- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Now   | A prioritized maintenance inbox           | Group repeated findings into a small queue with affected repositories, evidence, likely user impact and estimated effort. Keep unknown findings separate. | A maintainer can select the top three actions and explain why they outrank the rest without reading every repository report.  |
| Next  | Preview a change before creating work     | Show the exact proposed file/settings changes, applicability limits and expected verification before an explicitly requested draft PR.                    | The preview is bound to the assessed commit; creating a draft never silently broadens repository scope or merges it.          |
| Next  | Verify outcomes and suppress repeat noise | Compare before/after evaluations and track accepted exceptions with an owner and review date.                                                             | Completed fixes leave the queue only after verification; stale evidence and expired exceptions return with a specific reason. |
| Later | A useful weekly portfolio brief           | Summarize regressions, resolved problems and the next few decisions with a fixed reading budget.                                                          | The brief explains material changes and omits unchanged low-value findings; delivery is opt-in.                               |

## Measure value before expanding

Track maintainer minutes per accepted action, fraction of recommendations accepted, duplicate/noise dismissals and findings resolved per week. Proposed pilot gate: a top-three queue is reviewed in under five minutes and at least two actions are judged worth their effort.

Collect the baseline before building the first slice. Use voluntary pilot feedback and minimal aggregate events; do not log private content or credentials to measure adoption. If the first workflow is not used again, revisit the problem before adding the later features. Revenue impact is unvalidated.

## Next shippable slice

Build the ranked inbox from existing evaluations; include an explicit “not worth fixing” feedback action before adding automated remediation.

## Dependencies and deliberate limits

No blanket compliance score as a proxy for business value. No automatic merge or mass rollout. Keep repository-specific exceptions and private-repository access boundaries; use the existing catalog rather than another custom scanner.

Engineering work belongs in the milestone only when it enables that acceptance criterion. Prefer existing native libraries and test runners. Update this roadmap when a user-visible increment ships, recording the outcome and remaining limits rather than checking off implementation activity alone.
