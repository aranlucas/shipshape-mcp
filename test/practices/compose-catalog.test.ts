import { describe, expect, it } from "vitest";
import { composeCatalog, type CatalogPractice } from "@/practices/catalog";
import { parsePractice } from "@/practices/schema";

function practice(id: string, title = id, files: Record<string, string> = {}): CatalogPractice {
  const yaml = `version: 1\nid: ${id}\ntitle: ${title}\nsummary: s\nkind: files\nchecks:\n  - type: file-exists\n    path: README.md\n`;

  return { id, folder: id, yaml, instructions: null, files, parsed: parsePractice(yaml, id) };
}

const builtIns = { practices: [practice("lint"), practice("format")], version: "abcd1234" };

function compose(practices: CatalogPractice[], disabled: string[] = []) {
  return composeCatalog(
    { repo: "aranlucas/practices", sha: "c0ffee", practices, disabled },
    builtIns,
  );
}

function origins(catalog: ReturnType<typeof compose>) {
  return catalog.practices.map((item) => [item.id, item.origin, item.matchesBuiltIn ?? false]);
}

describe("composeCatalog", () => {
  it("serves built-ins when the catalog repository is empty", () => {
    expect(origins(compose([]))).toEqual([
      ["format", "built-in", false],
      ["lint", "built-in", false],
    ]);
  });

  it("lets a catalog copy override its built-in and adds custom practices", () => {
    const catalog = compose([practice("lint", "Edited lint"), practice("native")]);

    expect(origins(catalog)).toEqual([
      ["format", "built-in", false],
      ["lint", "override", false],
      ["native", "custom", false],
    ]);
    expect(catalog.practices.find((item) => item.id === "lint")?.yaml).toContain("Edited lint");
  });

  it("flags an override identical to its built-in, files included", () => {
    expect(origins(compose([practice("lint")]))).toContainEqual(["lint", "override", true]);
    expect(
      origins(compose([practice("lint", "lint", { "files/extra.json": "{}" })])),
    ).toContainEqual(["lint", "override", false]);
  });

  it("drops built-ins the catalog turns off and reports them", () => {
    const catalog = compose([], ["format", "unknown-id"]);

    expect(catalog.practices.map((item) => item.id)).toEqual(["lint"]);
    expect(catalog.disabled.map((item) => item.id)).toEqual(["format"]);
  });

  it("versions the effective set by catalog commit and built-in version", () => {
    expect(compose([]).sha).toBe("c0ffee+abcd1234");
    expect(compose([]).commit).toBe("c0ffee");
    expect(
      composeCatalog(
        { repo: "r", sha: "c0ffee", practices: [], disabled: [] },
        { practices: [], version: "abcd1234" },
      ).sha,
    ).toBe("c0ffee");
  });
});
