import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { parseCatalogSources, practiceSummary } from "../../practices/catalog-definition";
import { runCheck } from "../../practices/checks";
import type { CatalogPractice } from "../../practices/catalog-definition";
import type { RepoSnapshot } from "../../practices/snapshot";
import { applies } from "../../practices/applies";
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
  definition: CatalogPractice;
  yaml: string;
  instructions: string | null;
  files: Array<{ path: string; content: string }>;
}

const seedRoot = fileURLToPath(new URL("../../../catalog-seed", import.meta.url));

const sources = Object.fromEntries(
  readdirSync(seedRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);

      return [relative(seedRoot, path), readFileSync(path, "utf8")];
    }),
);

export function practiceSeed(definition: CatalogPractice): PracticeSeed {
  return {
    summary: practiceSummary(definition),
    definition,
    yaml: definition.yaml,
    instructions: definition.instructions,
    files: Object.entries(definition.files).map(([path, content]) => ({
      path: path.replace(/^files\//u, ""),
      content,
    })),
  };
}

const PRACTICES = parseCatalogSources(sources).map((definition) =>
  practiceSeed({ ...definition, origin: "built-in" }),
);

export function originalPracticeSeed(id: string): PracticeSeed | undefined {
  const original = PRACTICES.find((seed) => seed.summary.id === id);

  return original ? practiceSeed(original.definition) : undefined;
}

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

type SeedCheck = Omit<CheckResult, "state" | "actual">;

function actualFor(item: SeedCheck, state: CheckResult["state"]): string | null {
  const expected = item.expected;

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
  const snapshot: RepoSnapshot = {
    repo: { ...repo, installationId: 1 },
    headSha: "a".repeat(40),
    tree: {
      paths: new Set(
        repo.language === "TypeScript" || repo.language === "JavaScript" ? ["package.json"] : [],
      ),
      truncated: false,
    },
    treeError: null,
    files: new Map(),
    settings: null,
    protection: new Map(),
  };

  const parsed = seed.definition.parsed;
  const applicable = parsed.ok && applies(parsed.practice, snapshot.repo, snapshot);

  if (applicable === false) {
    return {
      cell: { state: "not_applicable", checkedAt: CHECKED_AT, failing: 0, unknown: 0 },
      checks: [],
    };
  }

  const roll = EXEMPLARY.has(repo.fullName) ? 0 : hash(`${repo.fullName}:${seed.summary.id}`);
  const unknownCase = roll > 0.95;
  const failing = roll > 0.8 && !unknownCase;

  const checks: CheckResult[] = (parsed.ok ? parsed.practice.checks : []).map((check, index) => {
    const item = runCheck(check, snapshot, seed.definition.files);
    const failsHere = failing && (index === 0 || hash(`${repo.name}${index}`) > 0.55);

    const unknownHere =
      unknownCase && index === (parsed.ok ? parsed.practice.checks.length : 0) - 1;

    const state = unknownHere ? "unknown" : failsHere ? "fail" : "pass";

    return {
      ...item,
      state,
      expected: item.expected,
      actual: actualFor(item, state),
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
