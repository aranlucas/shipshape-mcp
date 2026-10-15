import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregate, runCheck } from "@/practices/checks";
import { parsePractice, type Practice } from "@/practices/schema";
import type { RepoSnapshot } from "@/practices/snapshot";

const repositoryRoot = resolve(import.meta.dirname, "../..");

const seedRoot = join(repositoryRoot, "catalog-seed", "practices");

const expectedPracticeIds = [
  "oxforge-lint-format",
  "husky-lint-staged",
  "dependabot-weekly-grouped",
  "dependabot-automerge",
  "single-ci-workflow",
  "pinned-actions",
  "squash-only-merges",
  "secret-scanning",
] as const;

const fileWorkflowPracticeIds = new Set<string>([
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
  it("contains eight folder-matching, parseable practice definitions and their file sources", () => {
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

  it("passes every file and workflow seed against this repository's on-disk snapshot", () => {
    const snapshot = repositorySnapshot();
    const seeds = seedPractices();

    expect(seeds.filter((seed) => fileWorkflowPracticeIds.has(seed.parsed.id))).toHaveLength(6);

    for (const seed of seeds) {
      if (!fileWorkflowPracticeIds.has(seed.parsed.id)) {
        continue;
      }

      const checks = seed.parsed.checks.map((check) => runCheck(check, snapshot, seed.files));

      expect(aggregate(checks).state, seed.parsed.id).toBe("pass");
    }
  });
});
