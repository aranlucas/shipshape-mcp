import { describe, expect, it } from "vitest";
import {
  inspectLintConfig,
  joinPath,
  lintConfigPath,
  parseConfig,
  parentPath,
  resolvePath,
} from "@/practices/lint-config";

describe("Oxforge lint config helpers", () => {
  it("recognizes supported config paths and parses JSONC", () => {
    expect(lintConfigPath(".oxlintrc.json")).toBe(true);
    expect(lintConfigPath("packages/api/oxlint.config.mts")).toBe(true);
    expect(lintConfigPath("package.json")).toBe(false);
    expect(parseConfig('{/* policy */ "extends": ["./base.json"],}')).toEqual({
      extends: ["./base.json"],
    });
  });

  it("resolves repository-local paths without escaping", () => {
    expect(joinPath(".", "package.json")).toBe("package.json");
    expect(joinPath("config", "oxlint.json")).toBe("config/oxlint.json");
    expect(parentPath("config/oxlint.json")).toBe("config");
    expect(resolvePath("config", "../.oxlintrc.json")).toBe(".oxlintrc.json");
    expect(resolvePath(".", "../../outside.json")).toBeNull();
    expect(resolvePath(".", "/outside.json")).toBeNull();
  });

  it("deduplicates config branches and reports bounded traversal", () => {
    const files: Record<string, string | null> = {};

    for (let index = 0; index < 8; index += 1) {
      files[`config${index}.json`] = JSON.stringify({
        extends: [`./config${index + 1}.json`, `./config${index + 1}.json`],
      });
    }

    files["config8.json"] = JSON.stringify({
      extends: ["./node_modules/@aranlucas/oxforge/configs/recommended.json"],
    });

    const graph = inspectLintConfig(files, "config0.json", true);
    expect(graph.paths).toHaveLength(9);
    expect(graph.preset).toBe(true);
    expect(graph.uncertain).toBe(false);

    const limited = inspectLintConfig(files, "config0.json", true, new Set(), { remaining: 3 });
    expect(limited.uncertain).toBe(true);
    expect(limited.paths.length).toBeLessThanOrEqual(3);
  });

  it("keeps missing, malformed, and cyclic configs uncertain", () => {
    expect(inspectLintConfig({}, "missing.json", false, new Set()).uncertain).toBe(true);
    expect(inspectLintConfig({ "config.json": "{broken" }, "config.json", true).uncertain).toBe(
      true,
    );
    expect(
      inspectLintConfig(
        { "config.json": JSON.stringify({ extends: ["./config.json"] }) },
        "config.json",
        true,
      ).uncertain,
    ).toBe(true);
  });
});
