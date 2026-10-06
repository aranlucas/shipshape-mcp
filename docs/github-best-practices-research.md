# GitHub repository best practices

Researched from GitHub Docs on 2026-10-05. This note informs the optional
presets in Shipshape's settings drift dashboard and records useful practices
that the current checker cannot yet evaluate.

## Practices available in Shipshape

GitHub recommends protecting important branches with pull request reviews and
required status checks. Its branch protection settings can also enforce rules
for administrators, require conversation resolution, require signed commits,
and block force pushes or deletion. Shipshape's default branch preset enforces
the rule for administrators, requires resolved conversations and linear
history, and blocks force pushes and deletion without requiring an approving
review, so it also works for solo-maintained repositories. Team repositories
can add the optional review preset or set their own minimum review count. The
required status check names remain a repository choice, so set them explicitly
in YAML after confirming the checks the project actually runs. [GitHub's
repository best practices](https://docs.github.com/en/repositories/creating-and-managing-repositories/best-practices-for-repositories),
[protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)

GitHub says branch protection does not apply to administrators by default;
enabling admin enforcement extends the protection rules to them. The optional
team pull request review preset adds approval from a code owner and requires
someone other than the latest pusher to approve. A code-owner requirement only works
when a valid `CODEOWNERS` file is on the pull request's base branch and the
listed owners have write access. [Protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches),
[code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)

The signed-commits preset requires commits on the default branch to be signed.
GitHub requires branch protection to be enabled for this setting, and
contributors need a signing setup before turning it on. [Protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)

The existing security preset enables secret scanning, push protection, and
Dependabot security updates. GitHub's repository guidance also recommends
Dependabot alerts and code scanning. Dependabot security updates open pull
requests for vulnerable dependencies; push protection blocks pushes that
contain supported secrets. [Best practices for repositories](https://docs.github.com/en/repositories/creating-and-managing-repositories/best-practices-for-repositories),
[securing your repository](https://docs.github.com/en/code-security/getting-started/quickstart-for-securing-your-repository)

## Practices to add later

- **Workflow hardening:** GitHub recommends granting `GITHUB_TOKEN` only the
  permissions a workflow needs, with read access to repository contents as a
  useful default. It also recommends pinning third-party Actions to full commit
  SHAs. These require reading workflow YAML or Actions policy settings, which
  Shipshape's current repository-settings checker does not inspect. [Secure use of GitHub Actions](https://docs.github.com/en/actions/reference/security/secure-use)
- **Dependency review:** The Dependency Review Action can inspect dependency
  changes in pull requests and fail a required check when a change introduces a
  known vulnerability. This needs a workflow and project-specific severity
  choices, so it is not a repository-settings toggle in the current checker.
  [Dependency Review Action](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/customize-dependency-review-action)
- **Vulnerability reporting:** GitHub recommends a `SECURITY.md` file with
  reporting instructions and supports private vulnerability reporting for
  public repositories. Shipshape does not currently inspect repository files
  or evaluate that setting. [Repository security guidance](https://docs.github.com/en/repositories/creating-and-managing-repositories/best-practices-for-repositories),
  [vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting)
- **Repository onboarding:** GitHub recommends a README for every repository.
  A license, contribution guidelines, citation file, and code of conduct help
  explain project expectations. These are file checks, so they also sit outside
  the current settings drift evaluator. [Best practices for repositories](https://docs.github.com/en/repositories/creating-and-managing-repositories/best-practices-for-repositories)

## Scope

The dashboard presets are optional policy rules; adding one checks settings and
generates reviewable `gh api` commands. Shipshape does not execute those
commands. The new checks use branch protection fields already collected by the
app, including the last-push approval setting. Rulesets, workflow files,
Dependabot alerts, code scanning, private vulnerability reporting, and
repository documentation files still need separate evaluation.
