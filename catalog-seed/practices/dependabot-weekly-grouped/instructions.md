Keep one grouped weekly update policy, but adapt the update entries to the
package managers and ecosystems that the target repository actually uses. Keep
the Thursday schedule, timezone, and group name aligned with the practice.

Check actual update entries, not just the schedule label: npm and github-actions should join the same multi-ecosystem group, each with patterns ["*"], and that group should use open-pull-requests-limit: 1. The semantic check validates this grouping; the YAML-path checks validate the chosen schedule. It does not prove every workspace directory is covered or that GitHub has enabled Dependabot. Security update PRs may remain separate. Other ecosystems currently return unknown for review.
