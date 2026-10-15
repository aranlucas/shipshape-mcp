# Shipshape: personal practices across all my repositories

Status: approved direction (2026-10-15). Covers sub-projects 1 (Access) and
2 (Catalog + check engine) in detail, and fixes the API contract that
sub-project 3 (UI redesign) builds against.

## Intent

Shipshape becomes a single-user tool for Lucas (`aranlucas`) to define **his
own engineering practices** and see, across **every repository he owns or
administers — public and private, personal and org (`sidequest-labs`)** — which
repositories are behind. When a repository is behind, he clicks **Fix**, which
creates a **fix request** that an agent turns into a pull request (or, for
GitHub settings, an applied settings change after confirmation).

What he said:

- The dashboard is for _his_ best practices, not a generic GitHub-settings
  linter. GitHub repository settings are still one kind of practice.
- Practices are a mix of canonical files and rules, plus repo settings.
- Behind → click → PR. Agents write the PRs. Single user.
- Fixes are modeled as a transport-agnostic **fix request**; how a request
  reaches an agent (hosted sandbox, T3 Code webhook, GitHub hand-off, MCP
  events once standardized) is a later, pluggable decision.

Success looks like: one screen shows every repo × every practice with a
correct state; adding or editing a practice in the dashboard changes what is
checked everywhere without a code deploy; private and org repos appear.

## What gets retired

The public "portfolio maintenance" product surface is removed:

- The eight scoring MCP tools (`portfolio_snapshot`, `repo_readiness`,
  `branch_risk`, `delivery_hygiene`, `security_posture`, `standards_audit`,
  `settings_drift`, `action_plan`) and the code only they use
  (`src/domain/*`, `src/github/portfolio.ts`, most of `src/github/collectors.ts`,
  `src/review/*`).
- The `/app` settings-drift page and `/app/review` desk (the UI is rebuilt in
  sub-project 3).
- Public multi-user access and every "public repositories only" check
  (`PrivateRepositoryError` and its call sites).

Reused: the Octokit client and response validation (`src/github/client.ts`,
`schemas.ts`), bounded tree/blob reading, settings and branch-protection
collection from `src/drift/*` (re-pointed at per-repo `GET /repos/{owner}/{repo}`
so merge/security settings are no longer reported as "hidden"), workflow
inspection (least-privilege token, SHA-pinned actions, dependency review), the
Oxforge lint-config parser, cookie/session/CSRF helpers, security headers.

## Sub-project 1 — Access

### GitHub App

One GitHub App, owned by `aranlucas`, installed on `aranlucas` and
`sidequest-labs` (all repositories). Permissions for this sub-project:

| Permission     | Level | Why                                                                |
| -------------- | ----- | ------------------------------------------------------------------ |
| Metadata       | read  | repo listing                                                       |
| Contents       | read  | files, trees, workflows                                            |
| Administration | read  | merge settings, security_and_analysis, rulesets, branch protection |
| Pull requests  | read  | (future) link fix PRs                                              |

The catalog repository additionally needs **Contents: write** (the dashboard
commits practice edits). Because App permissions are per-App, Contents is
`write` at the App level; the Worker only issues write calls against the
catalog repository (enforced in code by an allowlist check, unit-tested).

Webhook events subscribed: `push`, `installation`, `installation_repositories`,
`repository`. Webhook URL: `${PUBLIC_ORIGIN}/github/webhook`, verified with
HMAC-SHA256 (`X-Hub-Signature-256`) against `GITHUB_WEBHOOK_SECRET` using a
constant-time compare.

### Tokens

- **Installation tokens** (server-to-server) do all repository reads. The
  Worker signs an RS256 App JWT with WebCrypto from `GITHUB_APP_PRIVATE_KEY`
  (PKCS#8 PEM; the setup doc shows the `openssl pkcs8 -topk8` conversion from
  GitHub's PKCS#1 download), exchanges it per installation, and caches each
  token in KV until 5 minutes before expiry. Use `@octokit/auth-app` (via the
  `octokit` package's `App`) if it runs on Workers; otherwise a small
  WebCrypto signer.
- **User login** uses the GitHub App's own OAuth (`GITHUB_APP_CLIENT_ID` /
  `GITHUB_APP_CLIENT_SECRET`) only to identify the person. The login succeeds
  only if the GitHub numeric user id equals `OWNER_GITHUB_ID` (env text
  binding). Any other account gets a 403 page. The user token is not used for
  repository reads and is not stored.

### Who can use it

- Web dashboard (`/app`): existing encrypted-cookie session design, but the
  session stores only `{ login, userId }` — no GitHub token.
- MCP (`/mcp`): keep `workers-oauth-provider` (MCP clients need OAuth), with
  the upstream GitHub step switched to the App's OAuth and the same
  `OWNER_GITHUB_ID` gate. Grant props carry `{ login, userId }`; tools use
  installation tokens.

### Repository inventory

`GET /app/installations` → for each installation,
`GET /installation/repositories` (paginate fully). Inventory is stored in D1
(table `repositories`) and refreshed on `installation*` / `repository`
webhooks and by the daily sweep. Archived repositories are kept but flagged;
forks are kept but flagged. Nothing filters on visibility.

## Sub-project 2 — Practice catalog and check engine

### Catalog repository

A private repository `aranlucas/practices` (name configurable via
`CATALOG_REPO` text binding, `owner/name`). Layout:

```text
practices/
  <practice-id>/
    practice.yml        # definition (schema below)
    instructions.md     # optional: extra guidance for the fixing agent
    files/              # optional: canonical files, mirrored repo-relative
      .husky/pre-commit
```

`practice-id` is kebab-case, unique, stable (it keys results).

### `practice.yml` schema (version 1)

```yaml
version: 1
id: husky-lint-staged
title: Pre-commit hooks with husky + lint-staged
summary: One line shown in the grid tooltip.
kind: files # files | settings  (decides PR vs settings apply later)
appliesTo: # all conditions must hold; omitted = no constraint
  owners: [aranlucas, sidequest-labs]
  languages: [TypeScript, JavaScript] # GitHub primary language
  hasFiles: [package.json] # all must exist at repo root paths
  include: ["*"] # name globs
  exclude: ["legacy-*"]
  archived: false # default false
  forks: false # default false
checks: # all must pass for the practice to pass
  - type: file-exists
    path: .husky/pre-commit
  - type: file-matches # canonical content, compared after
    path: .husky/pre-commit # normalizing line endings + trailing whitespace
    source: files/.husky/pre-commit
  - type: file-contains
    path: .github/workflows/ci.yml
    text: "uses: pnpm/setup@" # literal substring
  - type: json-path
    file: package.json
    path: scripts.prepare
    equals: husky # or: exists: true
  - type: yaml-path
    file: .github/dependabot.yml
    path: multi-ecosystem-groups.weekly-dependencies.schedule.day
    equals: thursday
  - type: dependency
    file: package.json
    name: "@aranlucas/oxforge"
    version: "0.2.2" # exact declaration in any dependency section
  - type: setting # GitHub repository settings (kind: settings)
    key: allow_squash_merge # top-level key from GET /repos/{owner}/{repo}
    equals: true
  - type: setting
    key: security_and_analysis.secret_scanning.status
    equals: enabled
  - type: branch-protection
    key: required_linear_history # existing drift setting ids
    equals: true
  - type: workflow # existing workflowSecurity checks
    check: pinned-actions # least-privilege-token | pinned-actions | dependency-review
```

Validation: zod schema, strict, with clear error messages; unknown check
types are a validation error. A practice that fails validation is shown in the
catalog with its error and evaluated as `unknown` for every repo.

### States

Per (repository, practice):

- `pass` — every check passed.
- `fail` — at least one check failed (a definite failure wins over unknowns).
- `unknown` — no check failed, but at least one could not be evaluated (API
  error, truncated tree, missing permission). Never inferred as pass.
- `not_applicable` — `appliesTo` excludes the repository.

Each check result records `{ type, label, state, path?, expected?, actual?,
detail? }`. `label` is human-readable and generated from the check.

### Evaluation

- Evaluating a repository reads, at the default branch head SHA: one recursive
  tree, the blobs referenced by checks (bounded: ≤ 64 blobs, ≤ 512 KB each),
  `GET /repos/{owner}/{repo}` when any setting check applies, branch protection
  when any branch-protection check applies, workflow files when any workflow
  check applies.
- Results are stored in D1 keyed by `(repo_full_name, practice_id)` with
  `head_sha`, `catalog_sha`, `checked_at`, `state`, `checks_json`.
- A repository is skipped if `head_sha` and `catalog_sha` are unchanged since
  its last evaluation.

### Triggers

- `push` webhook to a repository's default branch → enqueue that repository.
- `push` webhook to the catalog repository's default branch → reload catalog,
  enqueue every repository.
- Daily cron (`0 13 * * *` UTC) → refresh inventory, enqueue every repository.
- Dashboard "Refresh" → enqueue one repository or all.
- Work goes through a **Cloudflare Queue** (`shipshape-evaluations`), one
  message per repository, consumer batch size 5, so a sweep never hits a
  single invocation's subrequest limit.

### Editing practices from the dashboard

`PUT /app/api/practices/:id` validates the new `practice.yml` (and any files),
then commits to the catalog repository's default branch via the Git Data API
(one commit per save, message `practice(<id>): update from dashboard`).
Creating = PUT to a new id. Deleting = `DELETE`. The resulting `push` webhook
triggers re-evaluation; the response returns the new `catalog_sha`
immediately.

### Starter catalog

Ship a seed directory `catalog-seed/practices/` in this repo that mirrors
Lucas's current conventions, for him to push into `aranlucas/practices`:

1. `oxforge-lint-format` — `@aranlucas/oxforge` dependency, `.oxlintrc.json`
   extends the Oxforge recommended config, `oxfmt.config.ts` re-exports
   `@aranlucas/oxforge/format-config`.
2. `husky-lint-staged` — `.husky/pre-commit` runs `pnpm exec lint-staged`,
   `package.json` has `prepare: husky` and a `lint-staged` block.
3. `dependabot-weekly-grouped` — `.github/dependabot.yml` uses a
   `multi-ecosystem-groups` weekly Thursday 06:00 America/Los_Angeles group.
4. `dependabot-automerge` — `.github/workflows/dependabot-automerge.yml` exists.
5. `single-ci-workflow` — `.github/workflows/ci.yml` exists, uses
   `pnpm/setup@`, top-level `permissions: contents: read`.
6. `pinned-actions` — workflow check `pinned-actions`.
7. `squash-only-merges` — settings: squash on, merge commit off, rebase off,
   delete branch on merge.
8. `secret-scanning` — settings: secret scanning + push protection enabled.

All file-based seed practices apply to `languages: [TypeScript, JavaScript]`
with `hasFiles: [package.json]`; settings practices apply to all
non-archived, non-fork repositories.

## API contract (consumed by the sub-project 3 UI)

All under `/app/api`, JSON, session cookie required (401 otherwise), mutating
methods require same-origin + JSON body (existing `sameOrigin` rule).
TypeScript types live in `src/api/contract.ts` and are the single source of
truth for both sides.

```ts
type PracticeState = "pass" | "fail" | "unknown" | "not_applicable";

interface PracticeSummary {
  id: string;
  title: string;
  summary: string;
  kind: "files" | "settings";
  valid: boolean;
  error: string | null; // validation error, if invalid
}

interface RepoSummary {
  fullName: string; // "owner/name"
  owner: string;
  name: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  language: string | null;
  defaultBranch: string;
  pushedAt: string | null; // ISO
  url: string; // html_url
}

interface CellResult {
  state: PracticeState;
  checkedAt: string | null; // ISO; null = never evaluated
  failing: number; // count of failing checks
  unknown: number;
}

interface CheckResult {
  type: string;
  label: string;
  state: "pass" | "fail" | "unknown";
  path: string | null;
  expected: string | null;
  actual: string | null;
  detail: string | null;
}

// GET /app/api/overview
interface OverviewResponse {
  catalog: { repo: string; sha: string | null; loadedAt: string | null };
  practices: PracticeSummary[];
  repos: RepoSummary[];
  results: Record<string, Record<string, CellResult>>; // [fullName][practiceId]
  sweep: { lastCompletedAt: string | null; pending: number };
}

// GET /app/api/repos/:owner/:name
interface RepoDetailResponse {
  repo: RepoSummary;
  headSha: string | null;
  practices: Array<{
    practice: PracticeSummary;
    result: CellResult;
    checks: CheckResult[];
  }>;
}

// GET /app/api/practices/:id
interface PracticeDetailResponse {
  practice: PracticeSummary;
  yaml: string; // raw practice.yml
  instructions: string | null; // raw instructions.md
  files: Array<{ path: string; content: string }>; // files/ tree
  counts: Record<PracticeState, number>;
}

// PUT /app/api/practices/:id   body: { yaml, instructions?, files? }
// → 200 { catalogSha } | 400 { error, issues?: Array<{path: string; message: string}> }
// DELETE /app/api/practices/:id → 200 { catalogSha }
// POST /app/api/refresh  body: { repo?: "owner/name" } → 202 { queued: number }
```

Fix requests (`POST /app/api/fix-requests`) are sub-project 4 and not part of
this contract yet; the UI shows the Fix action disabled with "coming soon".

## MCP tools (replace the eight retired tools)

Read-only, same annotations as today:

- `practices_overview` — the `OverviewResponse`, optionally filtered by
  `owner` and/or `state`.
- `repo_practices({ owner, repo })` — `RepoDetailResponse`.
- `practice_detail({ id })` — `PracticeDetailResponse`.

## Bindings and setup

`cloudflare.config.ts` gains: `GITHUB_APP_ID` (text), `GITHUB_APP_PRIVATE_KEY`
(secret), `GITHUB_APP_CLIENT_ID` (text), `GITHUB_APP_CLIENT_SECRET` (secret),
`GITHUB_WEBHOOK_SECRET` (secret), `OWNER_GITHUB_ID` (text), `CATALOG_REPO`
(text), `DB` (D1), `EVALUATIONS` (Queue producer + consumer), cron trigger.
`GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` (old OAuth app) are removed.
`docs/setup.md` documents creating the App (permissions, events, callback
`${PUBLIC_ORIGIN}/callback`, webhook URL), converting the key, installing on
both accounts, creating D1/queue, and pushing `catalog-seed` to the catalog
repo. Local dev reads secrets from `.dev.vars` or process env.

## Error handling

- GitHub 401/403/404 on a feature endpoint → that check is `unknown` with a
  `detail` naming the endpoint and status. Never `pass`.
- Installation token failure → every repository in that installation is
  `unknown` for that run; previous results are kept with their `checkedAt`.
- Invalid practice YAML on save → 400 with zod issues mapped to YAML paths;
  nothing is committed.
- Webhook with a bad signature → 401, no work queued.

## Testing

- Unit: practice schema validation (valid/invalid fixtures), every check type
  (pass/fail/unknown), `appliesTo` matching, state aggregation, webhook
  signature verification, owner-id gate, catalog-write allowlist.
- Integration (Workers Vitest pool): queue consumer evaluates a repo end-to-end
  against a mocked GitHub (`fetchMock`) and writes D1 rows; `/app/api/overview`
  returns the contract shape; `PUT /app/api/practices/:id` commits via mocked
  Git Data API and rejects invalid YAML.
- `pnpm check` stays green throughout.

## Ownership

- Sub-projects 1, 2, and the API contract implementation: Codex (`gpt-6.1-sol`)
  in its own worktree. It may not edit `src/ui/**` or page templates.
- Sub-project 3 UI: Claude, against `src/api/contract.ts` and fixtures, under
  `src/ui/**`.
