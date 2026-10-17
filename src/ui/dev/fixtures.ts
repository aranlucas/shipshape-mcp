import type {
  CellResult,
  CheckResult,
  OverviewResponse,
  PracticeDetailResponse,
  PracticeState,
  PracticeSummary,
  RepoDetailResponse,
  RepoSummary,
} from "../../api/contract.ts";

// Development-only data in the shape of src/api/contract.ts. Organization
// repository names are invented; they stand in for private repositories.

type RepoSeed = [name: string, language: string | null, flags?: "fork" | "archived" | "private"];

const PERSONAL: RepoSeed[] = [
  ["set-and-signal", "TypeScript"],
  ["vienna-travel", "TypeScript"],
  ["agents-mobile", "TypeScript"],
  ["grocery-agent-mobile", "TypeScript"],
  ["multiplayer-chat", "TypeScript"],
  ["live-auction", "TypeScript"],
  ["resume-template", "JavaScript"],
  ["delivery-dash", "TypeScript"],
  ["react-hook-form-mantine", "TypeScript"],
  ["trailbraid", "TypeScript"],
  ["system-design-companion", "TypeScript"],
  ["spoonworld", "TypeScript"],
  ["snaphaul", "TypeScript"],
  ["shipshape-mcp", "TypeScript"],
  ["pantry-pulse", "TypeScript"],
  ["oxlint-plugin-anti-slop", "TypeScript"],
  ["oxforge", "JavaScript"],
  ["leavewell-departure-planner", "TypeScript"],
  ["lanternwake", "TypeScript"],
  ["holdfast-local", "TypeScript"],
  ["garmin-friend-finder", "TypeScript"],
  ["ai-shopping-mcp", "TypeScript"],
  ["pocket-park", "TypeScript"],
  ["agents", "Go"],
  ["dentistry-finetune", "Python"],
  ["lucas-plugins", "Python"],
  ["trading-mcp", "TypeScript"],
  ["lucas-kit", "JavaScript"],
  ["spring-todo-api", "Java"],
  ["keyboard-studio", "Swift"],
  ["dotfiles-notes", "Shell", "private"],
  ["budget-sheets", "TypeScript", "private"],
  ["career-ops", "JavaScript", "fork"],
  ["symphony", "Elixir", "fork"],
  ["old-portfolio", "JavaScript", "archived"],
];

const ORG: RepoSeed[] = [
  ["quest-api", "Go", "private"],
  ["quest-web", "TypeScript", "private"],
  ["ledger-service", "Java", "private"],
  ["ledger-batch", "Java", "private"],
  ["match-ml", "Python", "private"],
  ["infra-scripts", "Shell", "private"],
  ["thesis-notes", "TeX", "private"],
  ["pitch-deck", "TeX", "private"],
  ["landing-site", "JavaScript", "private"],
  ["mobile-app", "JavaScript", "private"],
  ["playground", null, "private"],
];

interface PracticeSeed {
  summary: PracticeSummary;
  checks: Array<Omit<CheckResult, "state" | "actual">>;
  forNode: boolean;
  yaml: string;
  instructions: string | null;
  files: Array<{ path: string; content: string }>;
}

function practice(
  id: string,
  title: string,
  summary: string,
  kind: "files" | "settings",
  checks: PracticeSeed["checks"],
  yaml: string,
  extra: Partial<Pick<PracticeSeed, "instructions" | "files">> = {},
): PracticeSeed {
  return {
    summary: {
      id,
      title,
      summary,
      kind,
      valid: true,
      error: null,
      origin: "built-in",
      matchesBuiltIn: false,
    },
    checks,
    forNode: kind === "files",
    yaml,
    instructions: extra.instructions ?? null,
    files: extra.files ?? [],
  };
}

function check(
  type: string,
  label: string,
  path: string | null,
  expected: string | null,
): PracticeSeed["checks"][number] {
  return { type, label, path, expected, detail: null };
}

const NODE_APPLIES = `appliesTo:
  languages: [TypeScript, JavaScript]
  hasFiles: [package.json]`;

type SemanticSeed = [
  id: string,
  title: string,
  summary: string,
  kind: "files" | "settings",
  checkType: string,
  label: string,
  applies: string,
];

// Catalog practices whose checks are a single semantic evaluator or setting.
const SEMANTIC_PRACTICES: SemanticSeed[] = [
  [
    "preferred-package-manager",
    "Use pnpm or Bun",
    "Use pnpm or Bun instead of npm for JavaScript dependencies and commands.",
    "files",
    "preferred-package-manager",
    "Lockfile and scripts use pnpm or Bun",
    "appliesTo:\n  hasFiles: [package.json]\n",
  ],
  [
    "pnpm-setup",
    "Use pnpm/setup",
    "Use pnpm/setup instead of pnpm/action-setup in workflows and composite actions.",
    "files",
    "pnpm-setup",
    "Workflows use pnpm/setup",
    "",
  ],
  [
    "vitest-test-script",
    "Vitest test scripts in every package",
    "Every tracked package.json must declare a test script that runs Vitest.",
    "files",
    "vitest-test-script",
    "Every package.json test script runs Vitest",
    "",
  ],
  [
    "required-package-scripts",
    "Required lint, format, and build scripts",
    "Every tracked package.json must declare non-empty lint, format, and build scripts.",
    "files",
    "required-package-scripts",
    "lint, format, and build scripts declared",
    "",
  ],
  [
    "portless-local-dev",
    "Use Portless for local web development",
    "Make portless run the default web dev command and install Portless as a local dev dependency.",
    "files",
    "portless-dev",
    "dev script runs portless",
    "appliesTo:\n  hasFiles: [package.json]\n",
  ],
  [
    "cloudflare-cf-cli",
    "Avoid direct Wrangler dependencies and CLI usage",
    "Keep Wrangler out of package dependencies, package scripts, workflows, and composite actions without requiring cf.",
    "files",
    "cloudflare-cf-cli",
    "No direct Wrangler usage",
    "",
  ],
  [
    "pr-workflow-efficiency",
    "Prevent wasted GitHub Actions runs",
    "Cancel superseded PR checks and skip every check job while the pull request is a draft.",
    "files",
    "pr-workflow-efficiency",
    "PR workflows cancel superseded runs and skip drafts",
    "",
  ],
  [
    "always-suggest-updating-pull-request-branches",
    "Always suggest updating pull request branches",
    "Offer to update pull request branches whenever they fall behind the base branch.",
    "settings",
    "setting",
    "allow_update_branch = true",
    "",
  ],
  [
    "allow-auto-merge",
    "Allow auto-merge",
    "Allow pull requests to merge automatically once merge requirements are met in public repositories.",
    "settings",
    "setting",
    "allow_auto_merge = true",
    "appliesTo:\n  visibility: public\n",
  ],
];

const PRACTICES: PracticeSeed[] = [
  practice(
    "oxforge-lint-format",
    "Oxforge lint and format",
    "Lint and format with the shared Oxforge presets.",
    "files",
    [
      check("dependency", "@aranlucas/oxforge declared", "package.json", null),
      check(
        "file-contains",
        ".oxlintrc.json extends the Oxforge recommended preset",
        ".oxlintrc.json",
        "@aranlucas/oxforge/configs/recommended.json",
      ),
      check("file-matches", "oxfmt.config.ts matches the catalog copy", "oxfmt.config.ts", null),
    ],
    `version: 1
id: oxforge-lint-format
title: Oxforge lint and format
summary: Lint and format with the shared Oxforge presets.
kind: files
${NODE_APPLIES}
checks:
  - type: dependency
    name: "@aranlucas/oxforge"
  - type: file-contains
    path: .oxlintrc.json
    text: "@aranlucas/oxforge/configs/recommended.json"
  - type: file-matches
    path: oxfmt.config.ts
    source: files/oxfmt.config.ts
`,
    {
      instructions:
        "Declare Oxforge with the repository's package manager; version ranges are accepted. Keep any repository-specific ignorePatterns in .oxlintrc.json.\n",
      files: [
        {
          path: "oxfmt.config.ts",
          content: 'export { default } from "@aranlucas/oxforge/format-config";\n',
        },
      ],
    },
  ),
  practice(
    "husky-lint-staged",
    "Pre-commit with husky and lint-staged",
    "Fix lint and formatting on staged files before every commit.",
    "files",
    [
      check(
        "file-matches",
        ".husky/pre-commit matches the catalog copy",
        ".husky/pre-commit",
        null,
      ),
      check("json-path", "package.json scripts.prepare = husky", "package.json", "husky"),
      check("json-path", "package.json lint-staged exists", "package.json", "exists"),
    ],
    `version: 1
id: husky-lint-staged
title: Pre-commit with husky and lint-staged
summary: Fix lint and formatting on staged files before every commit.
kind: files
${NODE_APPLIES}
checks:
  - type: file-matches
    path: .husky/pre-commit
    source: files/.husky/pre-commit
  - type: json-path
    file: package.json
    path: scripts.prepare
    equals: husky
  - type: json-path
    file: package.json
    path: lint-staged
    exists: true
`,
    { files: [{ path: ".husky/pre-commit", content: "pnpm exec lint-staged\n" }] },
  ),
  practice(
    "dependabot-weekly-grouped",
    "Weekly grouped Dependabot",
    "One grouped dependency PR every Thursday morning, Pacific time.",
    "files",
    [
      check("file-exists", ".github/dependabot.yml exists", ".github/dependabot.yml", null),
      check("yaml-path", "Group schedule day = thursday", ".github/dependabot.yml", "thursday"),
      check(
        "yaml-path",
        "Group timezone = America/Los_Angeles",
        ".github/dependabot.yml",
        "America/Los_Angeles",
      ),
    ],
    `version: 1
id: dependabot-weekly-grouped
title: Weekly grouped Dependabot
summary: One grouped dependency PR every Thursday morning, Pacific time.
kind: files
${NODE_APPLIES}
checks:
  - type: file-exists
    path: .github/dependabot.yml
  - type: yaml-path
    file: .github/dependabot.yml
    path: multi-ecosystem-groups.weekly-dependencies.schedule.day
    equals: thursday
  - type: yaml-path
    file: .github/dependabot.yml
    path: multi-ecosystem-groups.weekly-dependencies.schedule.timezone
    equals: America/Los_Angeles
`,
    {
      instructions:
        "Include an updates entry for every package ecosystem the repository uses (npm, github-actions, docker…), all in the weekly-dependencies group.\n",
    },
  ),
  practice(
    "dependabot-automerge",
    "Dependabot auto-merge workflow file",
    "Provide a Dependabot auto-merge workflow file; merge behavior requires separate review.",
    "files",
    [
      check(
        "file-exists",
        ".github/workflows/dependabot-automerge.yml exists",
        ".github/workflows/dependabot-automerge.yml",
        null,
      ),
    ],
    `version: 1
id: dependabot-automerge
title: Dependabot auto-merge workflow file
summary: Provide a Dependabot auto-merge workflow file; merge behavior requires separate review.
kind: files
${NODE_APPLIES}
checks:
  - type: file-exists
    path: .github/workflows/dependabot-automerge.yml
`,
  ),
  practice(
    "single-ci-workflow",
    "CI workflow configuration",
    "Provide ci.yml with read-only contents permission, pnpm setup, and required branch checks.",
    "files",
    [
      check("file-exists", ".github/workflows/ci.yml exists", ".github/workflows/ci.yml", null),
      check(
        "file-contains",
        "ci.yml uses pnpm/setup",
        ".github/workflows/ci.yml",
        "uses: pnpm/setup@",
      ),
      check("yaml-path", "ci.yml permissions.contents = read", ".github/workflows/ci.yml", "read"),
      check(
        "ci-required-checks",
        "ci.yml jobs are required status checks on the default branch",
        ".github/workflows/ci.yml",
        '["ci"]',
      ),
    ],
    `version: 1
id: single-ci-workflow
title: CI workflow configuration
summary: Provide ci.yml with read-only contents permission, pnpm setup, and required branch checks.
kind: files
${NODE_APPLIES}
checks:
  - type: ci-required-checks
  - type: file-exists
    path: .github/workflows/ci.yml
  - type: file-contains
    path: .github/workflows/ci.yml
    text: "uses: pnpm/setup@"
  - type: yaml-path
    file: .github/workflows/ci.yml
    path: permissions.contents
    equals: read
`,
  ),
  practice(
    "pinned-actions",
    "Actions pinned to commit SHAs",
    "Every third-party action is referenced by a full commit SHA.",
    "files",
    [check("workflow", "Actions pinned to full commit SHAs", ".github/workflows", null)],
    `version: 1
id: pinned-actions
title: Actions pinned to commit SHAs
summary: Every third-party action is referenced by a full commit SHA.
kind: files
${NODE_APPLIES}
checks:
  - type: workflow
    check: pinned-actions
`,
  ),
  practice(
    "squash-only-merges",
    "Squash-only merges",
    "Squash merges only, and merged branches are deleted.",
    "settings",
    [
      check("setting", "allow_squash_merge = true", null, "true"),
      check("setting", "allow_merge_commit = false", null, "false"),
      check("setting", "allow_rebase_merge = false", null, "false"),
      check("setting", "delete_branch_on_merge = true", null, "true"),
    ],
    `version: 1
id: squash-only-merges
title: Squash-only merges
summary: Squash merges only, and merged branches are deleted.
kind: settings
checks:
  - type: setting
    key: allow_squash_merge
    equals: true
  - type: setting
    key: allow_merge_commit
    equals: false
  - type: setting
    key: allow_rebase_merge
    equals: false
  - type: setting
    key: delete_branch_on_merge
    equals: true
`,
  ),
  practice(
    "secret-scanning",
    "Secret scanning and push protection",
    "GitHub blocks pushes that contain secrets.",
    "settings",
    [
      check("setting", "security_and_analysis.secret_scanning.status = enabled", null, "enabled"),
      check(
        "setting",
        "security_and_analysis.secret_scanning_push_protection.status = enabled",
        null,
        "enabled",
      ),
    ],
    `version: 1
id: secret-scanning
title: Secret scanning and push protection
summary: GitHub blocks pushes that contain secrets.
kind: settings
checks:
  - type: setting
    key: security_and_analysis.secret_scanning.status
    equals: enabled
  - type: setting
    key: security_and_analysis.secret_scanning_push_protection.status
    equals: enabled
`,
  ),
  ...SEMANTIC_PRACTICES.map(([id, title, summary, kind, checkType, label, applies]) =>
    practice(
      id,
      title,
      summary,
      kind,
      [check(checkType, label, null, kind === "settings" ? "true" : null)],
      `version: 1
id: ${id}
title: ${title}
summary: ${summary}
kind: ${kind}
${applies}checks:
  - type: ${checkType}
`,
    ),
  ),
];

const BROKEN: PracticeSummary = {
  id: "changesets-release",
  title: "changesets-release",
  summary: "This practice could not be read.",
  kind: "files",
  valid: false,
  error: 'checks.0.type: Invalid option: expected one of "file-exists"|"file-matches"|…',
  origin: "custom",
  matchesBuiltIn: false,
};

function hash(text: string): number {
  let value = 2166136261;

  for (const char of text) {
    value = Math.imul(value ^ (char.codePointAt(0) ?? 0), 16777619);
  }

  return (value >>> 0) / 4294967295;
}

function repoSummary(owner: string, [name, language, flag]: RepoSeed, index: number): RepoSummary {
  return {
    fullName: `${owner}/${name}`,
    owner,
    name,
    private: flag === "private" || owner === "sidequest-labs",
    archived: flag === "archived",
    fork: flag === "fork",
    language,
    defaultBranch: name === "reminder" ? "master" : "main",
    pushedAt: new Date(
      Date.UTC(2026, 9, 15, 17) - index * 7_200_000 * (1 + hash(name)),
    ).toISOString(),
    url: `https://github.com/${owner}/${name}`,
  };
}

const REPOS: RepoSummary[] = [
  ...PERSONAL.map((seed, index) => repoSummary("aranlucas", seed, index)),
  ...ORG.map((seed, index) => repoSummary("sidequest-labs", seed, index + 3)),
];

const NEVER_CHECKED = new Set(["sidequest-labs/playground", "sidequest-labs/mobile-app"]);

const EXEMPLARY = new Set(["aranlucas/shipshape-mcp", "aranlucas/oxforge"]);

const CHECKED_AT = "2026-10-15T15:12:00.000Z";

interface Evaluated {
  cell: CellResult;
  checks: CheckResult[];
}

type SeedCheck = PracticeSeed["checks"][number];

function catalogCopy(item: SeedCheck, seed: PracticeSeed): string | null {
  return seed.files.find((file) => file.path === item.path)?.content ?? null;
}

/** Mirrors src/practices/checks.ts: raw expected values, stringified. */
function expectedFor(item: SeedCheck, seed: PracticeSeed): string | null {
  if (item.type === "file-exists") {
    return "true";
  }

  if (item.type === "file-matches") {
    return catalogCopy(item, seed);
  }

  return item.expected === "exists" ? "true" : item.expected;
}

function actualFor(
  item: SeedCheck,
  seed: PracticeSeed,
  state: CheckResult["state"],
): string | null {
  const expected = expectedFor(item, seed);

  if (state === "pass") {
    return expected;
  }

  if (state === "unknown") {
    return null;
  }

  switch (item.type) {
    case "file-exists":
      return "false";
    case "file-matches":
      return item.path === ".husky/pre-commit" ? "npx lint-staged\nnpm test\n" : null;
    case "dependency":
      return "0.1.4";
    case "setting":
      return expected === "true" ? "false" : expected === "false" ? "true" : "disabled";
    default:
      return null;
  }
}

function evaluate(repo: RepoSummary, seed: PracticeSeed): Evaluated {
  const node = repo.language === "TypeScript" || repo.language === "JavaScript";

  if (repo.fork || repo.archived || (seed.forNode && !node)) {
    return {
      cell: { state: "not_applicable", checkedAt: CHECKED_AT, failing: 0, unknown: 0 },
      checks: [],
    };
  }

  const roll = EXEMPLARY.has(repo.fullName) ? 0 : hash(`${repo.fullName}:${seed.summary.id}`);
  const unknownCase = roll > 0.95;
  const failing = roll > 0.8 && !unknownCase;

  const checks: CheckResult[] = seed.checks.map((item, index) => {
    const failsHere = failing && (index === 0 || hash(`${repo.name}${index}`) > 0.55);
    const unknownHere = unknownCase && index === seed.checks.length - 1;
    const state = unknownHere ? "unknown" : failsHere ? "fail" : "pass";

    return {
      ...item,
      state,
      expected: expectedFor(item, seed),
      actual: actualFor(item, seed, state),
      detail:
        failsHere && item.type === "workflow"
          ? "2 actions use tags instead of commit SHAs: actions/checkout@v4, pnpm/setup@v3."
          : unknownHere
            ? repo.private
              ? "GET /repos/{owner}/{repo} returned 403 for this field"
              : "The workflow file was larger than 512 KB"
            : null,
    };
  });

  const failingCount = checks.filter((item) => item.state === "fail").length;
  const unknownCount = checks.filter((item) => item.state === "unknown").length;
  const state: PracticeState = failingCount ? "fail" : unknownCount ? "unknown" : "pass";

  return {
    cell: { state, checkedAt: CHECKED_AT, failing: failingCount, unknown: unknownCount },
    checks,
  };
}

function evaluateAll(): Map<string, Map<string, Evaluated>> {
  const results = new Map<string, Map<string, Evaluated>>();

  for (const repo of REPOS) {
    if (NEVER_CHECKED.has(repo.fullName)) {
      continue;
    }

    const row = new Map<string, Evaluated>();

    for (const seed of PRACTICES) {
      row.set(seed.summary.id, evaluate(repo, seed));
    }

    row.set(BROKEN.id, {
      cell: { state: "unknown", checkedAt: CHECKED_AT, failing: 0, unknown: 1 },
      checks: [],
    });
    results.set(repo.fullName, row);
  }

  return results;
}

// Overrides as they exist in production: some edited, one still identical to the built-in.
const FIXTURE_ORIGINS = new Map<string, Pick<PracticeSummary, "origin" | "matchesBuiltIn">>([
  ["dependabot-automerge", { origin: "override", matchesBuiltIn: false }],
  ["husky-lint-staged", { origin: "override", matchesBuiltIn: false }],
  ["pinned-actions", { origin: "override", matchesBuiltIn: true }],
]);

export interface FixtureStore {
  practices: PracticeSeed[];
  disabled: PracticeSeed[];
  broken: PracticeSummary;
  repos: RepoSummary[];
  results: Map<string, Map<string, Evaluated>>;
  catalogSha: string;
  pending: number;
}

export function createStore(): FixtureStore {
  return {
    practices: PRACTICES.map((seed) => ({
      ...seed,
      summary: { ...seed.summary, ...FIXTURE_ORIGINS.get(seed.summary.id) },
    })),
    disabled: [],
    broken: BROKEN,
    repos: REPOS,
    results: evaluateAll(),
    catalogSha: "3f9a2c1d7e5b4a6c8d0e2f1a3b5c7d9e0f2a4b6c",
    pending: 0,
  };
}

export function overview(store: FixtureStore): OverviewResponse {
  const results: OverviewResponse["results"] = {};

  for (const [repo, row] of store.results) {
    results[repo] = Object.fromEntries([...row].map(([id, value]) => [id, value.cell]));
  }

  return {
    catalog: {
      repo: "aranlucas/practices",
      sha: store.catalogSha,
      loadedAt: CHECKED_AT,
      disabled: store.disabled.map(({ summary }) => ({
        id: summary.id,
        title: summary.title,
        summary: summary.summary,
      })),
    },
    practices: [...store.practices.map((seed) => seed.summary), store.broken].toSorted((a, b) =>
      a.id.localeCompare(b.id),
    ),
    repos: store.repos.toSorted((a, b) => a.fullName.localeCompare(b.fullName)),
    results,
    sweep: { lastCompletedAt: CHECKED_AT, pending: store.pending },
  };
}

export function repoDetail(store: FixtureStore, fullName: string): RepoDetailResponse | null {
  const repo = store.repos.find((item) => item.fullName === fullName);

  if (!repo) {
    return null;
  }

  const row = store.results.get(fullName);

  return {
    catalog: { sha: store.catalogSha, loadedAt: CHECKED_AT },
    repo,
    headSha: row ? `${hash(fullName).toString(16).slice(2, 9)}e1c0ffee` : null,
    practices: [...store.practices.map((seed) => seed.summary), store.broken].map((summary) => {
      const value = row?.get(summary.id);

      return {
        practice: summary,
        result: value?.cell ?? { state: "unknown", checkedAt: null, failing: 0, unknown: 0 },
        checks: value?.checks ?? [],
        headSha: value ? "a".repeat(40) : null,
        catalogSha: value ? store.catalogSha : null,
      };
    }),
  };
}

export function practiceDetail(store: FixtureStore, id: string): PracticeDetailResponse | null {
  const seed = store.practices.find((item) => item.summary.id === id);

  if (!seed && id !== store.broken.id) {
    return null;
  }

  const counts: Record<PracticeState, number> = {
    pass: 0,
    fail: 0,
    unknown: 0,
    not_applicable: 0,
  };

  for (const row of store.results.values()) {
    const state = row.get(id)?.cell.state;

    if (state) {
      counts[state] += 1;
    }
  }

  return {
    practice: seed?.summary ?? store.broken,
    yaml:
      seed?.yaml ??
      "version: 1\nid: changesets-release\ntitle: Release with changesets\nsummary: Version and publish with changesets.\nkind: files\nchecks:\n  - type: file-exist\n    path: .changeset/config.json\n",
    instructions: seed?.instructions ?? null,
    files: seed?.files ?? [],
    counts,
  };
}
