import { describe, expect, it } from "vitest";
import { parseCatalogSources } from "@/practices/catalog-definition";

const yaml =
  "version: 1\nid: sample\ntitle: Sample\nsummary: Sample practice\nkind: files\nchecks:\n  - type: file-exists\n    path: package.json\n";

describe("catalog source definitions", () => {
  it("keeps dot-directory source files and instructions with their practice", () => {
    const [practice] = parseCatalogSources({
      "practices/sample/practice.yml": yaml,
      "practices/sample/instructions.md": "Owner instructions",
      "practices/sample/files/.husky/pre-commit": "pnpm lint",
      "practices/orphan/files/unused": "ignored without YAML",
      "README.md": "not a practice",
    });

    expect(practice).toMatchObject({
      id: "sample",
      yaml,
      instructions: "Owner instructions",
      files: { "files/.husky/pre-commit": "pnpm lint" },
      parsed: { ok: true },
    });
  });

  it("lets a disabled marker suppress a definition regardless of source order", () => {
    expect(
      parseCatalogSources({
        "practices/sample/disabled": "",
        "practices/sample/practice.yml": yaml,
      }),
    ).toEqual([]);
  });
});
