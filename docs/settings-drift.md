# Settings drift

`settings_drift({owner, rules | policy, limit})` checks an owner's public
repositories against declarative settings rules. For each matching repository
it reports each setting as `pass`, `fail`, or `unknown`, and builds `gh api`
commands that would fix the drift.

Shipshape stays read-only. It never sends a write request, and the commands are
plain text for a maintainer to review and run with their own administrator
credential. That is the main difference from hosted rule enforcers that apply
settings automatically with an installed GitHub App.

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
    branchProtection:
      # branch: release # omit to use each repository's default branch
      requiredSignatures: true
      enforceAdmins: true
      requiredLinearHistory: true
      allowForcePushes: false
      allowDeletions: false
      requiredConversationResolution: true
      dismissStaleReviews: true
      requireCodeOwnerReviews: true
      requiredApprovingReviews: 1 # minimum
      requiredStatusChecks: [build, test] # must be present
```

Each rule needs at least one setting, and every field is optional. Unknown
fields are rejected. A policy can have up to 25 rules with unique kebab-case ids.

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
  and a settings-page evidence URL.
- `remediation`: ordered steps with `method`, `path`, JSON `body`, and a
  ready-to-review `command`.
- `manual`: drift that no command can safely fix (see below).
- `conflicts`: settings on which matching rules disagree. A conflicting
  setting is never remediated. Fix the policy first.

When several rules match one repository, their expectations are combined:
approval counts take the highest minimum, and required status checks and topics
are merged.

The top-level `status` is `drifted` if any check fails. It is `unknown` when
evidence is missing, a repository could not be read, or the scan was truncated
by `limit` (at most 20 repositories) or by the 300-repository owner listing.
Otherwise it is `compliant`.

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

## Out of scope

Shipshape is limited to public repositories, so there are no visibility rules.
Team and collaborator permissions need organization membership scopes that
Shipshape does not request. Rulesets, scheduled runs, webhooks, audit history,
and automatic application are also not included.
