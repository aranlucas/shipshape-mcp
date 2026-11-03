# Practice coverage gaps

A pass means the inspected static evidence satisfies a check. It does not prove
that a command ran or that the repository is safe to change. Each built-in
practice's [`instructions.md`](../catalog-seed/practices) owns its remediation
and check-specific limits; [schema.ts](../src/practices/schema.ts) owns options.

Keep these gaps visible when interpreting results or designing new checks:

- **CI:** `single-ci-workflow` checks the named file, contents-read permission,
  root test-script invocation, and required static job contexts. Despite its
  name, it does not prove workflow uniqueness, successful execution, suitable
  runners, locked installs, or absence of duplicate work. Required checks use
  classic branch protection; ruleset-only requirements are not resolved.
- **Auto-merge:** the Dependabot practice checks workflow file presence, not
  workflow safety or successful merges. The separate repository setting practice
  applies only to public repositories; private repositories receive no penalty.
- **Tooling:** declared scripts and inherited configuration do not establish
  successful execution or justified overrides. Test placement, source aliases,
  standalone Playwright setup, and test quality still need review. Native,
  framework, generated, vendor, and Storybook cases need explicit consideration
  before introducing broader checks.
- **Availability:** transfers, inaccessible installations, permission failures,
  incomplete inventories, and read-budget limits do not prove a missing standard.
  Unknown and pending results must remain distinct from failed checks.

Built-ins ship alongside their evaluators. A private catalog override blocks
built-in updates even when it is an identical copy. Preserve owner exceptions
when updating overrides; reset to the built-in only when that is intended. The
[evidence behind personal preferences](recurring-preferences.md) explains why
some rules are portfolio-wide and others remain application-specific.
