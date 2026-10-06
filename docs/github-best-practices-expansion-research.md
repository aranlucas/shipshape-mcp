# GitHub best-practices expansion research

Researched from GitHub's official documentation on 2026-10-05. This note
records the API contracts and file-location rules needed to add read-only
checks to Shipshape. The API examples below use the versioned REST API with
`Accept: application/vnd.github+json` and `X-GitHub-Api-Version` headers.

## Workflow hardening

### Inspecting workflow files

Use `GET /repos/{owner}/{repo}/actions/workflows` to enumerate workflows. The
response is `200 OK` and includes `total_count` plus each workflow's `path`,
such as `.github/workflows/ci.yml`. Fine-grained GitHub App and personal access
tokens need the repository `Actions: read` permission; public repositories can
be queried without authentication. The endpoint is paginated, with a maximum
of 100 items per page and a default of 30. [REST API endpoints for
workflows](https://docs.github.com/en/rest/actions/workflows#list-repository-workflows)

Fetch each path with `GET /repos/{owner}/{repo}/contents/{path}?ref=<ref>`.
Fine-grained tokens need `Contents: read`; public repository content can be
read without authentication. A file response is `200 OK` and contains
base64-encoded content by default. The endpoint documents `403 Forbidden` and
`404 Resource not found` for access and missing-file cases, respectively; a
raw media type can be requested when parsing YAML. [REST API endpoints for
repository contents](https://docs.github.com/en/rest/repos/contents#get-repository-content)

For a read-only checker, treat `404` as “the workflow/file is absent” and
`403` or another transport/API failure as “unknown” rather than as a failed
best-practice check. Resolve the file at the repository's default branch (or
the explicitly requested ref) so that the result is tied to a reproducible
revision.

### Least-privilege `GITHUB_TOKEN`

GitHub recommends granting `GITHUB_TOKEN` the minimum access required and says
read access to repository contents is a useful default. Workflows can set
`permissions` at the workflow level or on an individual job. Permission values
are `read`, `write`, or `none`; `write` includes `read`. If a workflow specifies
one permission, every permission it omits is set to `none`. The special values
`read-all`, `write-all`, and `{}` are also valid. [Secure use
reference](https://docs.github.com/en/actions/reference/security/secure-use)
and [workflow syntax for GitHub
Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)

A practical static check can therefore report workflows that omit an explicit
workflow/job `permissions` block, use `write-all`, or grant broad write access
when the jobs only need read access. Absence of a block is not proof that the
effective token is writable: GitHub first applies the repository,
organization, or enterprise default and then applies workflow/job overrides.
For an accurate repository-level default, use the read-only endpoint below as
additional context.

`GET /repos/{owner}/{repo}/actions/permissions/workflow` returns `200 OK` with
`default_workflow_permissions` (`read` or `write`) and
`can_approve_pull_request_reviews` (boolean). Fine-grained tokens require
`Administration: read`. The corresponding write endpoint requires
`Administration: write`, returns `204`, and can return `409` when the owning
organization prevents the change; Shipshape should not call it for a scan.
[REST API endpoints for GitHub Actions
permissions](https://docs.github.com/en/rest/actions/permissions#get-default-workflow-permissions-for-a-repository)

### Pinning Actions to full commit SHAs

GitHub says a full-length commit SHA is currently the only way to use an
Action as an immutable release. Tags can move or be deleted, so a scanner can
flag `uses: owner/action@vN` and `uses: owner/action@vN.N.N` references that
are not full 40-character commit SHAs. The SHA should be verified as belonging
to the referenced action repository, not a fork. [Secure use
reference](https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions)

GitHub also exposes a repository policy that can enforce this rule:

- `GET /repos/{owner}/{repo}/actions/permissions` returns `200 OK` and includes
  `sha_pinning_required`, `enabled`, and `allowed_actions`. Fine-grained tokens
  require `Administration: read`.
- `PUT` on the same endpoint can set `sha_pinning_required`, but requires
  `Administration: write` and returns `204 No Content`; it is a mutation and is
  outside a read-only scan.

The repository policy applies to all Actions, including GitHub-authored and
organization-authored Actions. GitHub documents that reusable workflows may
still be referenced by tag when the policy is enabled, so a static checker
should distinguish a reusable workflow reference from a step-level Action and
should report that exception clearly. [Managing GitHub Actions settings for a
repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#setting-the-permissions-of-the-github_token-for-your-repository)

## Dependency review

The official Dependency Review Action is a workflow feature. GitHub's example
adds a workflow under `.github/workflows`, triggers it on `pull_request`, and
sets `permissions: contents: read`. The current documentation example uses
`actions/dependency-review-action@v4`; the workflow-pinning guidance above
means a hardened repository should reference the reviewed v4 commit SHA rather
than the moving tag. [Configuring the dependency review
action](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/configure-dependency-review-action#using-inline-configuration-to-set-up-the-dependency-review-action)

The action scans dependency changes in pull requests and can fail the check
when a new dependency has a known vulnerability. Its documented configuration
supports `fail-on-severity` values `critical`, `high`, `moderate`, and `low`;
`fail-on-scopes` accepts `development`, `runtime`, and `unknown`; and
`allow-licenses` and `deny-licenses` are mutually exclusive. A repository can
also supply a local or external `config-file`. [Customizing the dependency
review action configuration](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/customize-dependency-review-action)

GitHub's REST API also exposes the underlying dependency comparison:
`GET /repos/{owner}/{repo}/dependency-graph/compare/{basehead}`, where
`basehead` must be `{base}...{head}` and an optional `name` selects one
manifest. Fine-grained tokens require `Contents: read`, and public resources
can be queried without authentication. The documented statuses are `200` for
the dependency diff, `400` for a bad request, `403` for a private repository
without GitHub Advanced Security or for a fork, `404` for a missing resource,
and `500`/`503` for server/service failures. [REST API endpoints for
dependency review](https://docs.github.com/en/rest/dependency-graph/dependency-review#get-a-diff-of-the-dependencies-between-commits)

Dependency review requires the dependency graph. GitHub says it is available
for all repositories with the dependency graph enabled, while private and
internal repositories additionally require GitHub Team or GitHub Enterprise
Cloud with GitHub Code Security. [Quickstart for securing your
repository](https://docs.github.com/en/code-security/getting-started/quickstart-for-securing-your-repository#managing-dependency-review)

For a static settings scan, the strongest evidence is a workflow whose trigger
includes `pull_request` and whose steps contain
`actions/dependency-review-action`; branch-protection required checks can then
be used to determine whether that workflow is enforced. A repository can have
the dependency graph enabled without having this optional enforcement workflow.

## Security policy and private vulnerability reporting

GitHub recommends a `SECURITY.md` security policy with supported versions and
instructions for reporting vulnerabilities. Repository-level community health
files may be stored in the repository root, `.github`, or `docs`, with
`.github` taking precedence over the root and `docs`. A separate public
`.github` repository owned by the account or organization can provide default
community health files when the target repository has no local file. [Creating
a default community health
file](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file#creating-a-repository-for-default-files)
and [adding a security policy](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/add-security-policy)

`SECURITY.md` is independent from private vulnerability reporting. GitHub
states that private vulnerability reporting is available to owners and
administrators of public repositories, and that a policy file is displayed to
reporters when present. [Privately reporting a security
vulnerability](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately)

The read-only status endpoint is:

```text
GET /repos/{owner}/{repo}/private-vulnerability-reporting
```

Fine-grained GitHub App and personal access tokens need `Metadata: read`.
A successful response is `200 OK` with `{ "enabled": true|false }`; GitHub
documents `422` as a bad-request response. The mutating endpoints use the same
URL:

- `PUT` enables the feature, requires admin access and `Administration: write`,
  and returns `204 No Content` (or `422` for a bad request).
- `DELETE` disables the feature with the same admin/permission requirement and
  returns `204 No Content` (or `422`).

Use only the `GET` endpoint in a read-only checker. [REST API endpoints for
repositories](https://docs.github.com/en/rest/repos/repos#check-if-private-vulnerability-reporting-is-enabled-for-a-repository)

If a repository uses a custom private-report form, GitHub recognizes
`.github/VULNERABILITY_REPORT.yml` or `.github/VULNERABILITY_REPORT.yaml`.
[Configuring private vulnerability reporting for a
repository](https://docs.github.com/en/enterprise-cloud@latest/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository#customizing-the-vulnerability-reporting-form)

## README, license, contribution, conduct, and citation files

### One API call for most community files

`GET /repos/{owner}/{repo}/community/profile` returns `200 OK` with community
metrics and a `files` object. The documented fields include
`code_of_conduct`, `code_of_conduct_file`, `contributing`, `license`,
`readme`, `issue_template`, and `pull_request_template`, as well as the
`health_percentage`. Fine-grained tokens need `Contents: read`; public
repositories can be queried without authentication. The repository cannot be
a fork. This endpoint does not report `SECURITY.md` or citation files, so those
still need explicit content checks. [REST API endpoints for community
metrics](https://docs.github.com/en/rest/metrics/community#get-community-profile-metrics)

### Recognized paths

- **README:** GitHub recognizes a README in `.github`, the repository root, or
  `docs`, and chooses in that order when more than one exists. The dedicated
  `GET /repos/{owner}/{repo}/readme` endpoint returns the preferred README;
  `200` means found, `404` means absent, and `422` means validation or spam
  protection. [About the repository README
  file](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)
  and [Get a repository README](https://docs.github.com/en/rest/repos/contents#get-a-repository-readme)
- **CONTRIBUTING:** GitHub recognizes a contribution file in `.github`, the
  root, or `docs`, using that same precedence. Contribution filenames are not
  case sensitive. [Setting guidelines for repository
  contributors](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors#adding-a-contributingmd-file)
- **CODE_OF_CONDUCT:** GitHub looks in `.github`, the root, then `docs` and
  uses the first file found. For the public community profile, the file must
  be non-empty and must not say the project has no code of conduct. [Adding a
  code of conduct to your
  project](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/adding-a-code-of-conduct-to-your-project)
- **LICENSE:** License text belongs in the repository root. GitHub's license
  instructions use `LICENSE` or `LICENSE.md`; the licensing guidance also
  documents common `LICENSE.txt` and `LICENSE.rst` names. GitHub's Licensee
  detector matches a known license from the contents of the project's license
  file, so a custom or unrecognized license may not populate the detected
  license field. `GET /repos/{owner}/{repo}/license` returns `200` with the
  detected file, or `404` when no license is detected; fine-grained tokens
  need `Metadata: read`, and public repositories can be queried anonymously.
  [Adding a license to a
  repository](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/adding-a-license-to-a-repository),
  [Licensing a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository),
  and [Get the license for a
  repository](https://docs.github.com/en/rest/licenses/licenses#get-the-license-for-a-repository)
- **CITATION:** `CITATION.cff` must be in the repository root. GitHub also
  recognizes these case-insensitive root-level alternatives: `CITATION`,
  `CITATIONS`, `CITATION.bib`, `CITATIONS.bib`, `CITATION.md`, and
  `CITATIONS.md`. R packages commonly use `inst/CITATION`. The citation file
  is not included in the community profile metrics response. [About CITATION
  files](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-citation-files)

For file checks that need the exact path, use the repository contents endpoint
with `Contents: read` and treat the supported paths above as alternatives. A
`404` means that candidate path is missing; query all supported alternatives
before reporting the file absent. The community profile endpoint is useful for
matching GitHub's own README, license, CONTRIBUTING, and code-of-conduct
selection behavior, while explicit contents checks are required for
`SECURITY.md`, citation files, and workflow YAML.

## Implementation implications for Shipshape

1. Keep workflow checks read-only: list workflows, fetch YAML, inspect
   `permissions` and `uses`, and optionally read the Actions policy endpoints.
2. Report an unknown state for private-repository permission failures or API
   service failures; do not convert access failures into a missing-file result.
3. Treat the full SHA rule and least-privilege rule as separate findings. A
   repository can pin every Action while still granting an excessive token, or
   use minimal permissions while referencing mutable tags.
4. Use the community profile metrics as a source of truth for the five files it
   exposes, then add explicit path probes for `SECURITY.md` and citation files.
5. Keep private vulnerability reporting status separate from the presence and
   contents of `SECURITY.md`; GitHub explicitly treats them as independent
   controls.
