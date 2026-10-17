import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

const directories: string[] = [];

type Tree = Record<string, string>;

function folder(files: Tree): string {
  const directory = mkdtempSync(join(tmpdir(), "shipshape-catalog-"));
  directories.push(directory);

  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  }

  return directory;
}

function diff(seed: Tree, catalog: Tree) {
  const result = spawnSync(
    process.execPath,
    [
      join(root, "scripts/catalog-diff.ts"),
      "--seed-dir",
      folder(seed),
      "--catalog-dir",
      folder(catalog),
      "--repo",
      "aranlucas/practices",
    ],
    { encoding: "utf8" },
  );

  return { status: result.status, output: result.stdout + result.stderr };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("catalog diff", () => {
  it("passes when every seed practice is published", () => {
    const practices = {
      "practices/lint/practice.yml": "id: lint\n",
      "practices/lint/instructions.md": "Lint.\n",
    };

    const result = diff(practices, practices);

    expect(result.status).toBe(0);
    expect(result.output).toContain("Every catalog-seed practice is in aranlucas/practices.");
  });

  it("fails when a seed practice never reached the catalog", () => {
    const result = diff(
      {
        "practices/lint/practice.yml": "id: lint\n",
        "practices/format/practice.yml": "id: format\n",
      },
      { "practices/lint/practice.yml": "id: lint\n" },
    );

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/Missing from aranlucas\/practices[^\n]*\n {2}format\n/u);
  });

  it("reports catalog-only practices and edited files without failing", () => {
    const result = diff(
      {
        "practices/lint/practice.yml": "id: lint\n",
        "practices/lint/files/oxlint.json": "{}\n",
      },
      {
        "practices/lint/practice.yml": "id: lint\ntitle: Edited\n",
        "practices/native/practice.yml": "id: native\n",
      },
    );

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/Only in aranlucas\/practices[^\n]*\n {2}native\n/u);
    expect(result.output).toContain("  lint: files/oxlint.json, practice.yml");
  });
});
