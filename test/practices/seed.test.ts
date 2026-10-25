import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregate, runCheck } from "@/practices/checks";
import { GitHubBranchProtectionSchema } from "@/github/schemas";
import { protectionState } from "@/practices/protection";
import { parsePractice, type Practice } from "@/practices/schema";
import type { RepoSnapshot } from "@/practices/snapshot";
import { makeSnapshot, type SnapshotOptions } from "@test/helpers/snapshot";

const repositoryRoot = resolve(import.meta.dirname, "../..");

const seedRoot = join(repositoryRoot, "catalog-seed", "practices");

const expectedPracticeIds = [
  "portless-local-dev",
  "cloudflare-cf-cli",
  "preferred-package-manager",
  "pnpm-setup",
  "vitest-test-script",
  "required-package-scripts",
  "pr-workflow-efficiency",
  "oxforge-lint-format",
  "husky-lint-staged",
  "dependabot-weekly-grouped",
  "dependabot-automerge",
  "single-ci-workflow",
  "pinned-actions",
  "squash-only-merges",
  "always-suggest-updating-pull-request-branches",
  "allow-auto-merge",
  "secret-scanning",
] as const;

const fileWorkflowPracticeIds = new Set<string>([
  "portless-local-dev",
  "cloudflare-cf-cli",
  "preferred-package-manager",
  "pnpm-setup",
  "vitest-test-script",
  "required-package-scripts",
  "pr-workflow-efficiency",
  "oxforge-lint-format",
  "husky-lint-staged",
  "dependabot-weekly-grouped",
  "dependabot-automerge",
  "single-ci-workflow",
  "pinned-actions",
]);

interface SeedPractice {
  folder: string;
  parsed: Practice;
  files: Record<string, string>;
}

type SettingCase = [label: string, settings: SnapshotOptions["settings"], state: string];

function filesOnDisk(directory: string): Map<string, string> {
  const files = new Map<string, string>();

  for (const entry of readdirSync(directory)) {
    if (entry === ".git" || entry === "node_modules" || entry === "coverage") {
      continue;
    }

    const path = join(directory, entry);
    const relativePath = relative(directory, path);

    if (statSync(path).isDirectory()) {
      for (const [nestedPath, content] of filesOnDisk(path)) {
        files.set(join(relativePath, nestedPath), content);
      }
    } else {
      files.set(relativePath, readFileSync(path, "utf8"));
    }
  }

  return files;
}

function seedPractices(): SeedPractice[] {
  if (!statSync(seedRoot, { throwIfNoEntry: false })?.isDirectory()) {
    return [];
  }

  return readdirSync(seedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((folder) => {
      const folderPath = join(seedRoot, folder.name);

      const parsed = parsePractice(
        readFileSync(join(folderPath, "practice.yml"), "utf8"),
        folder.name,
      );

      if (!parsed.ok) {
        throw new Error(
          `${folder.name}/practice.yml is invalid: ${parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join(", ")}`,
        );
      }

      return {
        folder: folder.name,
        parsed: parsed.practice,
        files: Object.fromEntries(
          statSync(join(folderPath, "files"), { throwIfNoEntry: false })?.isDirectory()
            ? [...filesOnDisk(join(folderPath, "files"))].map(([path, content]) => [
                `files/${path}`,
                content,
              ])
            : [],
        ),
      };
    });
}

function repositorySnapshot(): RepoSnapshot {
  const files = filesOnDisk(repositoryRoot);

  return {
    repo: {
      fullName: "aranlucas/shipshape-mcp",
      owner: "aranlucas",
      name: "shipshape-mcp",
      installationId: 1,
      private: false,
      archived: false,
      fork: false,
      language: "TypeScript",
      defaultBranch: "main",
      pushedAt: null,
      url: "https://github.com/aranlucas/shipshape-mcp",
    },
    headSha: "a".repeat(40),
    tree: { paths: new Set(files.keys()), truncated: false },
    treeError: null,
    files,
    settings: null,
    protection: new Map(),
  };
}

describe("seed practice catalog", () => {
  it.each([
    ["bun", "oven-sh/setup-bun@v2"],
    ["bun", "./tooling/github/setup"],
    ["pnpm", "pnpm/setup@v3"],
    ["pnpm", "./tooling/github/setup"],
  ])("accepts %s CI with %s while retaining CI safeguards", (manager, action) => {
    const seed = seedPractices().find((practice) => practice.parsed.id === "single-ci-workflow");

    if (!seed) {
      throw new Error("CI practice is missing");
    }

    const workflow = `permissions:
  contents: read
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: ${action}
      - run: ${manager} run test
`;

    const files = {
      "package.json": JSON.stringify({
        packageManager: `${manager}@1.0.0`,
        scripts: { test: "vitest run" },
      }),
      ".github/workflows/ci.yml": workflow,
      "tooling/github/setup/action.yml": `runs:\n  using: composite\n  steps:\n    - uses: ${manager === "bun" ? "oven-sh/setup-bun@v2" : "pnpm/setup@v3"}\n`,
    };

    const snapshot = makeSnapshot({
      paths: Object.keys(files),
      files,
      protection: {
        main: {
          status: "protected",
          protection: protectionState(
            GitHubBranchProtectionSchema.parse({ required_status_checks: { contexts: ["ci"] } }),
          ),
        },
      },
    });

    const evaluate = (value: RepoSnapshot) =>
      aggregate(seed.parsed.checks.map((check) => runCheck(check, value, seed.files))).state;

    expect(evaluate(snapshot)).toBe("pass");
    snapshot.files.set(
      ".github/workflows/ci.yml",
      workflow.replace(`${manager} run test`, "echo tests skipped"),
    );
    expect(evaluate(snapshot)).toBe("fail");
    snapshot.files.set(
      ".github/workflows/ci.yml",
      workflow.replace("contents: read", "contents: write"),
    );
    expect(evaluate(snapshot)).toBe("fail");
    snapshot.files.set(".github/workflows/ci.yml", workflow);
    snapshot.protection.set("main", { status: "unprotected" });
    expect(evaluate(snapshot)).toBe("fail");
  });

  it.each<SettingCase>([
    ["enabled", { allow_update_branch: true }, "pass"],
    ["disabled", { allow_update_branch: false }, "fail"],
    ["undisclosed", {}, "unknown"],
    ["uncollected", null, "unknown"],
    ["unreadable", { error: "GET /repos/octo/demo returned 403" }, "unknown"],
  ])("evaluates branch update suggestions when settings are %s", (_label, settings, state) => {
    const seed = seedPractices().find(
      (practice) => practice.parsed.id === "always-suggest-updating-pull-request-branches",
    );

    if (!seed) {
      throw new Error("Branch update suggestions practice is missing");
    }

    const snapshot = makeSnapshot({ settings });
    const checks = seed.parsed.checks.map((check) => runCheck(check, snapshot, seed.files));

    expect(aggregate(checks).state).toBe(state);
  });

  it.each<SettingCase>([
    ["enabled", { allow_auto_merge: true }, "pass"],
    ["disabled", { allow_auto_merge: false }, "fail"],
    ["undisclosed", {}, "unknown"],
    ["uncollected", null, "unknown"],
    ["unreadable", { error: "GET /repos/octo/demo returned 403" }, "unknown"],
  ])("evaluates auto-merge when public repository settings are %s", (_label, settings, state) => {
    const seed = seedPractices().find((practice) => practice.parsed.id === "allow-auto-merge");

    if (!seed) {
      throw new Error("Allow auto-merge practice is missing");
    }

    expect(seed.parsed.appliesTo.visibility).toBe("public");

    const snapshot = makeSnapshot({ settings });
    const checks = seed.parsed.checks.map((check) => runCheck(check, snapshot, seed.files));

    expect(aggregate(checks).state).toBe(state);
  });

  it("contains folder-matching, parseable practice definitions and their file sources", () => {
    const seeds = seedPractices();

    expect(seeds.map((seed) => seed.folder).toSorted()).toEqual(
      [...expectedPracticeIds].toSorted(),
    );

    const missingSources: string[] = [];

    for (const seed of seeds) {
      const folderPath = join(seedRoot, seed.folder);

      expect(
        parsePractice(readFileSync(join(folderPath, "practice.yml"), "utf8"), seed.folder),
      ).toEqual({
        ok: true,
        practice: seed.parsed,
      });

      for (const check of seed.parsed.checks) {
        if (
          check.type === "file-matches" &&
          !statSync(join(folderPath, check.source), { throwIfNoEntry: false })
        ) {
          missingSources.push(`${seed.folder}/${check.source}`);
        }
      }
    }

    expect(missingSources).toEqual([]);
  });

  it("passes file checks and preserves unknown for conditional CI and protection", () => {
    const snapshot = repositorySnapshot();
    const seeds = seedPractices();

    expect(seeds.filter((seed) => fileWorkflowPracticeIds.has(seed.parsed.id))).toHaveLength(13);

    for (const seed of seeds) {
      if (!fileWorkflowPracticeIds.has(seed.parsed.id)) {
        continue;
      }

      const checks = seed.parsed.checks.map((check) => runCheck(check, snapshot, seed.files));

      expect(aggregate(checks).state, `${seed.parsed.id}: ${JSON.stringify(checks)}`).toBe(
        seed.parsed.id === "single-ci-workflow" ? "unknown" : "pass",
      );

      for (const check of checks) {
        // The draft guard makes CI execution conditional; protection is unavailable locally.
        const expected =
          check.type === "ci-test-script" || check.type === "ci-required-checks"
            ? "unknown"
            : "pass";

        expect(check.state, `${seed.parsed.id}: ${check.type}`).toBe(expected);
      }
    }
  });
});
