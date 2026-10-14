# Shared engineering standards

`standards_audit({owner, repo})` inspects the default branch at one immutable
commit. `action_plan` includes these findings alongside existing maintenance
checks. This is a static, public-repository audit: it never clones a repository,
executes its commands, or claims that tests passed.

## Adopt a baseline

Commit `.shipshape.yml` at the repository root:

```yaml
baseline: shipshape/recommended@1
```

The built-in v1 baseline has ten equally weighted checks: baseline adoption,
format/lint/test/typecheck command declarations, lockfile presence, explicit
TypeScript strictness, pull-request workflow presence, quality-command wiring,
and dependency update configuration presence. Rule identifiers are stable.
The same version applies across repositories. Future semantic changes require
a new baseline version rather than silently changing v1 requirements.

Node packages use `package.json` scripts (`format:check` preferred to `format`,
`lint`, `test`, `typecheck`). Commands are declarations, not validation of their
contents. Go and Python packages are discovered through `go.mod` and
`pyproject.toml`; declare their commands explicitly. Type checking is not a
separate requirement for Go. A missing `go.sum` remains unknown because modules
without external dependencies may not need one.

```yaml
baseline: shipshape/recommended@1
packages:
  - path: services/api
    commands:
      format: ./scripts/check-format.sh
      lint: go vet ./...
      test: go test -race ./...
  - path: tools/python
    commands:
      format: ruff format --check .
      lint: ruff check .
      test: pytest
      typecheck: mypy .
exceptions:
  - rule: typecheck
    path: tools/python
    reason: Migrating the existing tool to typed interfaces
    expires: "2026-12-01"
```

Commands are matched literally against unconditional PR workflow run steps in
the package working directory. The evaluator also follows simple npm, pnpm,
and yarn script references and `&&` chains. Unsupported shell syntax, conditions,
reusable workflows, inherited TypeScript configuration, and ancestor lockfile
membership remain unknown. CI wiring is configuration evidence, not proof of a
required status check or successful execution. Dependency updater presence does
not establish ecosystem coverage. The base profile does not interpret application architecture, test quality,
accessibility, or arbitrary linter configuration.

## Opt in to Oxforge convergence

Keep lint rules in [Oxforge](https://github.com/aranlucas/oxforge), then ask
Shipshape to check how each Node package adopts them:

```yaml
baseline: shipshape/recommended@1
convergence:
  profile: oxforge@1
  version: 0.2.2
```

The version is the exact expected dependency declaration, not a lookup of the
latest release. Pin it in your shared policy to use the same expectation across
repositories. This optional profile adds three stable rules in a separate
`repository_convergence` category, leaving the v1 baseline weights unchanged:

- `standards.oxforge-version` (40 points): the package declares the expected
  Oxforge version. An absent or different exact declaration fails; ranges,
  catalogs, conflicting declarations, unreadable manifests, and possible
  workspace-provided dependencies remain unknown. Installed/locked versions
  are not verified.
- `standards.oxforge-lint` (40 points): the declared lint command selects a
  JSON/JSONC config whose local extends chain reaches an Oxforge `base` or
  `recommended` preset through a relative `node_modules` path. Simple script
  aliases and `&&` chains are supported, as are explicit `--config`/`-c` paths.
  Shell wrappers, dynamic JS/TS configs, ambiguous config files, cycles, and
  unavailable extensions stay unknown. Framework-only presets do not prove
  base adoption. This checks static entry-point wiring, not effective rules,
  nested overrides, file coverage, dependency resolution, or successful lint.
- `standards.oxforge-legacy` (20 points): selected config chains should not
  reference repository-local anti-slop plugins. Such references prompt a
  migration review; Shipshape does not compare plugin source or remove local
  protections. Published plugins and local rule overrides are allowed.

Findings appear in the existing audit and action plan, with per-package plans
preserving every package's remediation. Dated exceptions work with these rule
names too. Non-Node packages are not applicable. Omit `convergence` to retain
the existing baseline checks and scores. Shared convergence settings are
inherited when omitted locally; an explicit local profile replaces them.

Only known lint config filenames are additionally fetched, within the existing
read budgets. Other custom config paths can be discovered but remain unknown
when their contents are unavailable. Config chains and script aliases are
bounded to 16 levels and 64 total expansions per package. No config module or repository command is executed.

## Share policy between codebases

Store a policy in a public repository and pin its full commit SHA:

```yaml
baseline: shipshape/recommended@1
extends:
  owner: your-account
  repo: engineering-standards
  ref: "0123456789abcdef0123456789abcdef01234567" # replace with a real commit
  path: policies/default.yml
```

The shared file uses the same schema. Package commands merge by exact path;
local commands override matching shared commands. Exceptions merge by path and
rule. There is one level of inheritance, and private policy repositories,
symlink policy files, mutable refs, unknown fields, and path traversal are
rejected or reported unavailable. A shared policy is reusable configuration,
not an enforced organization-level security boundary: repositories can override
it. Expired exceptions are reported and their checks resume. Valid exceptions
are shown explicitly as `not_applicable`, not passing checks. Baseline adoption
cannot be exempted.

## Reading results

Results contain commit, baseline, collection time, per-package profiles,
commands, exceptions, checks, evidence URLs, a repository rollup, and a ranked
plan. `status` distinguishes `meets-baseline`, `needs-attention`, and `unknown`.
A high numeric score alone is not proof of compliance: existing Shipshape
scoring does not penalize unknown observations. Always read status, unknown
counts, and completeness together.

The repository rollup conservatively takes the worst state for each rule;
individual package audits retain all findings. At most 20 packages are evaluated.
File reads are bounded to 80 requests, four concurrent reads, 128 KB per file,
and a 2 MB declared-size budget. Truncated discovery and unreadable configuration
are surfaced through unknown states and completeness. Symlinks are not followed.

Malformed local policies return an actionable tool error. Unavailable shared
policies leave checks unknown. This release has no historical storage, automatic
regression notifications, CI execution companion, private-repository support,
or automatic fixes. To compare multiple codebases, call `standards_audit` for
each; historical drift reporting can build on these commit-specific results.
