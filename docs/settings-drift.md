# Settings drift

`settings_drift({owner, rules | policy, page, limit})` checks one page of an
owner's public repositories against declarative settings rules. `page` selects
the one-based GitHub repository listing page; `limit` selects the number of
repositories per page, up to GitHub's API maximum of 100. Continue through pages
until `scope.hasNextPage` is `false`; there is no total repository-count limit.
GitHub documents the 100-item maximum in its [REST repository API reference](https://docs.github.com/en/rest/repos/repos).
For each matching repository Shipshape reports each setting as `pass`, `fail`,
or `unknown`, and builds `gh api` commands that would fix the drift.

Shipshape stays read-only. It never sends a write request, and the commands are
plain text for a maintainer to review and run with their own administrator
credential. That is the main difference from hosted rule enforcers that apply
settings automatically with an installed GitHub App.

## Use the dashboard

The website companion at `/app` runs the same check without an MCP client.
Sign in with GitHub (`read:user`), edit rules in YAML or add presets, and run
the check against any owner. The starter policy includes every built-in
best-practice check; team review controls remain optional. A previously saved
two-rule starter expands in the editor, while custom saved policies stay as
they are. Results show one page at a time with previous and next controls; keep
going until GitHub has no next page. There is no total repository-count limit.
Each result shows checks, conflicts, manual items, and copyable fix commands.
**Save rules** stores the policy under your GitHub login, and **Download YAML**
exports it for a policy repository.

## Write rules

```yaml
version: 1
rules:
  - id: services
    description: Squash-only services with protected default branches
    repositories:
      include: ["svc-*", "api"]
      exclude: ["svc-sandbox"]
      forks: false # default
      archived: false # default
    merge:
      allowSquash: true
      allowMergeCommit: false
      allowRebase: false
      allowAutoMerge: true
      allowUpdateBranch: true
      deleteBranchOnMerge: true
    features:
      issues: true
      wiki: false
      projects: false
      discussions: false
    topics:
      required: [service]
      forbidden: [deprecated]
    security:
      secretScanning: true
      pushProtection: true
      dependabotSecurityUpdates: true
      privateVulnerabilityReporting: true
    repositoryFiles:
      readme: true
      license: true
      contributing: true
      codeOfConduct: true
      security: true
      citation: true
    workflowSecurity:
      leastPrivilegeToken: true
      pinnedActions: true
      dependencyReview: true
    repositoryRules:
      activeRuleset: true
    branchProtection:
      # branch: release # omit to use each repository's default branch
      requiredSignatures: true
      enforceAdmins: true
      requiredLinearHistory: true
      allowForcePushes: false
      allowDeletions: false
      requiredConversationResolution: true
      requiredStatusChecks: [build, test] # must be present
```

Each rule needs at least one setting, and every field is optional. Unknown
fields are rejected. A policy can have up to 25 rules with unique kebab-case ids.

The default branch preset does not require an approving review, so it works for
solo-maintained repositories. Teams can add a review requirement with
`requiredApprovingReviews`, or use the optional team-review preset. Code-owner
review only has an effect when the repository has a valid `CODEOWNERS` file on
the base branch, with owners who can write to the repository. Signed-commit
requirements can affect contributor workflows, so enable them only after
contributors are ready to sign commits. See the [GitHub best-practices
research](github-best-practices-research.md) for source-backed guidance and
practices and the limits of the static workflow checks.

Repository selectors are case-insensitive name globs that support `*` and `?`.
They are deliberately not regular expressions: glob matching runs in linear
time, so a shared policy cannot stall the Worker with a catastrophically
backtracking pattern. Forks and archived repositories are excluded unless a
rule opts in.

## Provide the policy

Pass rules inline as the `rules` argument, which suits a quick conversational
check, or store them as YAML in a public repository and pin the file to a commit:

```json
{
  "owner": "your-org",
  "policy": {
    "owner": "your-org",
    "repo": "engineering-standards",
    "ref": "0123456789abcdef0123456789abcdef01234567",
    "path": "policies/repo-rules.yml"
  }
}
```

Pass exactly one of `rules` or `policy`. Policy files must be regular files
under 64 KB in a public repository. Symlinks, mutable refs, and private policy
repositories are rejected.

## Read results

Each scanned repository includes:

- `checks`: one entry per rule and setting, with `expected`, `actual`, a state,
  and an evidence URL. File and workflow checks link to the corresponding tree.
- `remediation`: ordered steps with `method`, `path`, JSON `body`, and a
  ready-to-review `command`.
- `manual`: drift that no command can safely fix (see below).
- `conflicts`: settings on which matching rules disagree. A conflicting
  setting is never remediated. Fix the policy first.

When several rules match one repository, their expectations are combined:
approval counts take the highest minimum, and required status checks and topics
are merged.

The top-level `status` is `drifted` if any check on the current page fails. It
is `unknown` when evidence is missing, a repository could not be read, or the
owner has another repository listing page. For a complete owner scan, continue
until `scope.hasNextPage` is `false`.

## Visibility and unknown states

Shipshape authenticates with the `read:user` scope. GitHub shows some settings,
such as merge strategies, `delete_branch_on_merge`, security analysis, and
branch protection details, only to repository administrators. When a value is
hidden, its check is `unknown`, never `pass`. Features, topics, and whether a
branch is protected at all are public, so those checks always resolve.

Remediation is chosen to be safe despite that uncertainty:

- Repository settings and topics are written with idempotent `PATCH` and `PUT`
  requests, so unknown settings are included in the suggested command. Topics
  are replaced with the complete list: current topics, plus required ones, minus
  forbidden ones.
- Signed-commit requirements use the dedicated `required_signatures`
  `POST`/`DELETE` endpoint. An unprotected branch is protected first.
- Other protection changes need a full `PUT .../protection` body. Shipshape
  builds it only when it can see the current protection, keeps existing
  stricter settings, and only adds status checks. If protection is hidden, or
  the branch restricts who can push (a restriction list Shipshape cannot
  rebuild), the drift goes to `manual` instead.

Workflow checks inspect YAML only. They do not execute workflows, resolve
reusable workflows or composite actions, prove what permissions a workflow
needs, or verify that a dependency-review workflow is a required status check.
When a workflow cannot be read or the repository tree is truncated, Shipshape
reports `unknown`. The recognized file checks inspect files in the repository;
they do not resolve default community health files inherited from an owner's
`.github` repository. An active-ruleset check only confirms that at least one
repository or inherited organization ruleset is enabled; it does not verify
which branches or rules that ruleset covers.

## Out of scope

Shipshape is limited to public repositories, so there are no visibility rules.
Team and collaborator permissions need organization membership scopes that
Shipshape does not request. Dependabot alert status, code scanning setup,
scheduled runs, webhooks, audit history, and automatic application are also not
included. The app keeps the GitHub OAuth scope at `read:user`; it does not ask
for `public_repo` or administrator access to inspect security alert controls.
