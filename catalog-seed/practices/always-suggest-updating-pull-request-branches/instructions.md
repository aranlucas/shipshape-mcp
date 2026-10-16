Apply this policy to non-archived, non-fork repositories. In the repository's
Settings → General → Pull Requests section, enable **Always suggest updating
pull request branches**. The repository API should report `allow_update_branch: true`.

This setting offers branch updates when a pull request falls behind its base
branch, including when branch protection does not require it to be up to date.
If GitHub does not disclose the setting or the settings read fails, keep the
result unknown and report the missing evidence.

See [GitHub's documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-suggestions-to-update-pull-request-branches).
