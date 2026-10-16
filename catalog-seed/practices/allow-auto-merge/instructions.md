Apply this policy to public, non-archived, non-fork repositories. Private
repositories are not applicable and must receive no failure or score penalty
for this practice, regardless of their auto-merge setting or account plan.

In the repository's Settings → General → Pull Requests section, enable
**Allow auto-merge**. The repository API should report `allow_auto_merge: true`.
If GitHub does not disclose the setting or the settings read fails, keep the
result unknown and report the missing evidence.

This enables auto-merge as an option for individual pull requests once their
merge requirements are met. The separate `dependabot-automerge` practice checks
for the Dependabot workflow.

See [GitHub's documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-auto-merge-for-pull-requests-in-your-repository).
