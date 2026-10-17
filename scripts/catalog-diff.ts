import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

// The dashboard and MCP tools only check practices published in the catalog
// repository. catalog-seed/ is the starting copy, so a practice added there
// does nothing in production until it is copied into the catalog as well.

const { values } = parseArgs({
  options: {
    repo: { type: "string", default: process.env.CATALOG_REPO ?? "aranlucas/practices" },
    "seed-dir": { type: "string", default: resolve(import.meta.dirname, "../catalog-seed") },
    "catalog-dir": { type: "string" },
  },
});

const { repo } = values;

function files(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
    .toSorted();
}

/** Practice id → (path within the practice folder → content). */
function practices(root: string): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();
  const base = join(root, "practices");

  for (const id of readdirSync(base).toSorted()) {
    const folder = join(base, id);

    result.set(
      id,
      new Map(files(folder).map((path) => [path, readFileSync(join(folder, path), "utf8")])),
    );
  }

  return result;
}

function clone(): string {
  const directory = mkdtempSync(join(tmpdir(), "shipshape-catalog-"));

  const result = spawnSync("gh", ["repo", "clone", repo, directory, "--", "--depth", "1", "-q"], {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    rmSync(directory, { recursive: true, force: true });
    process.stderr.write(`Couldn't clone ${repo}. Sign in with \`gh auth login\` and try again.\n`);
    process.exit(2);
  }

  return directory;
}

function section(title: string, lines: string[]): void {
  if (lines.length > 0) {
    process.stdout.write(`\n${title}\n${lines.map((line) => `  ${line}`).join("\n")}\n`);
  }
}

const catalogDir = values["catalog-dir"] ?? clone();

try {
  const seed = practices(values["seed-dir"]);
  const catalog = practices(catalogDir);

  const missing = [...seed.keys()].filter((id) => !catalog.has(id));
  const extra = [...catalog.keys()].filter((id) => !seed.has(id));

  const changed = [...seed].flatMap(([id, seedFiles]) => {
    const published = catalog.get(id);

    if (!published) {
      return [];
    }

    const paths = [...new Set([...seedFiles.keys(), ...published.keys()])].toSorted();
    const differing = paths.filter((path) => seedFiles.get(path) !== published.get(path));

    return differing.length > 0 ? [`${id}: ${differing.join(", ")}`] : [];
  });

  section(`Missing from ${repo} (production never checks these):`, missing);
  section(`Only in ${repo}:`, extra);
  section(`Different from catalog-seed (review before copying either way):`, changed);

  if (missing.length > 0) {
    process.stdout.write(
      `\nCopy each missing folder into practices/ in ${repo} and open a pull request there.\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(`\nEvery catalog-seed practice is in ${repo}.\n`);
  }
} finally {
  if (!values["catalog-dir"]) {
    rmSync(catalogDir, { recursive: true, force: true });
  }
}
