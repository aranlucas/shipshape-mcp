import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledBuiltIns, builtInVersion } from "@/practices/built-in";

const { practices: BUILT_IN_PRACTICES, version: BUILT_IN_VERSION } = bundledBuiltIns();

const seedRoot = resolve(import.meta.dirname, "../../catalog-seed/practices");

function filesOnDisk(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)))
    .toSorted();
}

describe("built-in practices", () => {
  it("bundles every catalog-seed practice, including dot-directory files", () => {
    const onDisk = readdirSync(seedRoot).toSorted();

    expect(BUILT_IN_PRACTICES.map((practice) => practice.id)).toEqual(onDisk);

    for (const practice of BUILT_IN_PRACTICES) {
      const folder = join(seedRoot, practice.id);

      expect(practice.yaml).toBe(readFileSync(join(folder, "practice.yml"), "utf8"));
      expect(practice.parsed.ok, practice.id).toBe(true);
      expect(
        [
          "practice.yml",
          ...(practice.instructions === null ? [] : ["instructions.md"]),
          ...Object.keys(practice.files),
        ].toSorted(),
      ).toEqual(filesOnDisk(folder));
    }

    expect(
      BUILT_IN_PRACTICES.find((practice) => practice.id === "husky-lint-staged")?.files,
    ).toHaveProperty(["files/.husky/pre-commit"]);
  });

  it("versions the bundled content so any edit changes it", () => {
    expect(BUILT_IN_VERSION).toMatch(/^[0-9a-f]{8}$/u);
    expect(builtInVersion({ "practices/a/practice.yml": "id: a\n" })).not.toBe(
      builtInVersion({ "practices/a/practice.yml": "id: a\ntitle: changed\n" }),
    );
    expect(
      builtInVersion({ "practices/a/practice.yml": "x", "practices/b/practice.yml": "y" }),
    ).toBe(builtInVersion({ "practices/b/practice.yml": "y", "practices/a/practice.yml": "x" }));
  });
});
