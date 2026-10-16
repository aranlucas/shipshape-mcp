import { describe, expect, it } from "vitest";
import { runCheck } from "@/practices/checks";
import { CheckSchema } from "@/practices/schema";
import { makeSnapshot } from "@test/helpers/snapshot";

const check = CheckSchema.parse({ type: "oxforge-format" });

const base = 'export { default } from "@aranlucas/oxforge/format-config";';

const tailwind = 'export { default } from "@aranlucas/oxforge/format-tailwind";';

const projectConfig = `
import base from "@aranlucas/oxforge/format-tailwind";
const config = {
  ...base,
  sortTailwindcss: { ...base.sortTailwindcss, stylesheet: "app/globals.css" },
};
export default config;
`;

function snapshot(config: string, manifest = "{}", directory = ".") {
  const prefix = directory === "." ? "" : `${directory}/`;
  const files = { [`${prefix}package.json`]: manifest, [`${prefix}oxfmt.config.ts`]: config };

  return makeSnapshot({ files, paths: Object.keys(files) });
}

const tailwindManifest = JSON.stringify({ devDependencies: { tailwindcss: "^4.0.0" } });

describe("Oxforge format policy", () => {
  it("accepts ai-shopping-mcp's typed Tailwind config without changing its stylesheet", () => {
    const config = `import type { OxfmtConfig } from "oxfmt";
import base from "@aranlucas/oxforge/format-tailwind";

const config: OxfmtConfig = {
  ...base,
  sortTailwindcss: { ...base.sortTailwindcss, stylesheet: "views/styles.css" },
};

export default config;
`;

    const exactMatch = CheckSchema.parse({
      type: "file-matches",
      path: "oxfmt.config.ts",
      source: "files/oxfmt.config.ts",
    });

    expect(
      runCheck(exactMatch, snapshot(config, tailwindManifest), {
        "files/oxfmt.config.ts": `${base}\n`,
      }).state,
    ).toBe("fail");
    expect(runCheck(check, snapshot(config, tailwindManifest), {}).state).toBe("pass");
    expect(
      runCheck(
        check,
        snapshot(
          config.replace('{ ...base.sortTailwindcss, stylesheet: "views/styles.css" }', "false"),
          tailwindManifest,
        ),
        {},
      ).state,
    ).toBe("fail");
  });

  it("ignores inline type imports while checking the runtime export", () => {
    const config = `import { type OxfmtConfig } from "oxfmt";
      import base from "@aranlucas/oxforge/format-config";
      const config: OxfmtConfig = { ...base, printWidth: 120 };
      export default config;`;

    expect(runCheck(check, snapshot(config), {}).state).toBe("pass");
  });

  it.each([
    'export type { default } from "@aranlucas/oxforge/format-config";',
    'export { type default } from "@aranlucas/oxforge/format-config";',
  ])("does not treat type-only Oxforge re-exports as a runtime configuration: %s", (config) => {
    expect(runCheck(check, snapshot(config), {}).state).toBe("fail");
  });

  it("accepts the shared base for repositories without Tailwind", () => {
    expect(runCheck(check, snapshot(base), {}).state).toBe("pass");
    expect(runCheck(check, snapshot(tailwind), {}).state).toBe("pass");
  });

  it.each(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])(
    "requires sorting for tailwindcss in %s, including unresolved versions",
    (section) => {
      const manifest = JSON.stringify({ [section]: { tailwindcss: "catalog:" } });

      const result = runCheck(check, snapshot(base, manifest), {});

      expect(result).toMatchObject({
        state: "fail",
        path: "oxfmt.config.ts",
      });
      expect(result.detail).toContain("enable sortTailwindcss");
      expect(runCheck(check, snapshot(projectConfig, manifest), {}).state).toBe("pass");
    },
  );

  it.each([
    tailwind,
    projectConfig,
    projectConfig.replaceAll('"', "'").replace("app/globals.css", "src/styles/theme.css"),
    `import { format as sharedFormat } from "@aranlucas/oxforge/format";
     export default sharedFormat({ sortTailwindcss: { stylesheet: "src/main.css" } });`,
    `import format from "@aranlucas/oxforge/format";
     export default format({ sortTailwindcss: true });`,
    `import base from "@aranlucas/oxforge/format-config";
     export default { ...base, printWidth: 120, sortTailwindcss: { stylesheet: "src/main.css" } };`,
  ])("accepts Tailwind presets and static project overrides: %s", (config) => {
    expect(runCheck(check, snapshot(config, tailwindManifest), {}).state).toBe("pass");
  });

  it.each(["false", "null", '"enabled"'])("rejects overridden sorting: %s", (value) => {
    const config = projectConfig.replace(
      '{ ...base.sortTailwindcss, stylesheet: "app/globals.css" }',
      value,
    );

    expect(runCheck(check, snapshot(config, tailwindManifest), {}).state).toBe("fail");
  });

  it("uses the final override order", () => {
    const config = `import base from "@aranlucas/oxforge/format-tailwind";
      const local = { sortTailwindcss: false };
      export default { ...base, ...local };`;

    expect(runCheck(check, snapshot(config, tailwindManifest), {}).state).toBe("fail");
    expect(
      runCheck(
        check,
        snapshot(config.replace("...base, ...local", "...local, ...base"), tailwindManifest),
        {},
      ).state,
    ).toBe("pass");
  });

  it("does not mistake unused imports, comments or strings for shared formatting", () => {
    const config = `import base from "@aranlucas/oxforge/format-tailwind";
      // export default base;
      export default { note: "sortTailwindcss: true" };`;

    expect(runCheck(check, snapshot(config, tailwindManifest), {}).state).toBe("fail");
  });

  it.each([
    `${projectConfig}\nconfig.sortTailwindcss = false;`,
    'import arbitrary from "./project.js"; export default arbitrary();',
    "export default process.env.FORMAT_CONFIG;",
    "export default {",
    projectConfig.replace("const config =", "enum Mode { Default }\nconst config ="),
    projectConfig.replace(
      "const config =",
      "namespace Runtime { export const value = 1; }\nconst config =",
    ),
    projectConfig.replace("const config =", "declare const config: FormatConfig;\nconst unused ="),
    projectConfig.replace("const config =", "type Config = FormatConfig;\nconst config ="),
    `${projectConfig}\nconfig!.sortTailwindcss = false;`,
    'import type base from "@aranlucas/oxforge/format-config"; export default base;',
    projectConfig.replace("stylesheet:", "get stylesheet() { throw new Error(); }, unused:"),
  ])("keeps dynamic or unsupported code unknown without executing it: %s", (config) => {
    expect(runCheck(check, snapshot(config, tailwindManifest), {}).state).toBe("unknown");
  });

  it("distinguishes missing, unread and malformed inputs", () => {
    const missing = snapshot(base);
    missing.files.delete("oxfmt.config.ts");
    missing.tree?.paths.delete("oxfmt.config.ts");
    expect(runCheck(check, missing, {}).state).toBe("fail");
    missing.tree?.paths.add("oxfmt.config.ts");
    expect(runCheck(check, missing, {}).state).toBe("unknown");
    missing.files.set("oxfmt.config.ts", { error: "GitHub returned HTTP 403" });
    expect(runCheck(check, missing, {}).state).toBe("unknown");
    expect(runCheck(check, snapshot(base, "{"), {}).state).toBe("unknown");
    expect(runCheck(check, snapshot(base, '{"devDependencies": []}'), {}).state).toBe("unknown");
    expect(runCheck(check, makeSnapshot({ tree: null }), {}).state).toBe("unknown");
  });

  it("evaluates package-local manifests and formatter configs", () => {
    const nested = CheckSchema.parse({ type: "oxforge-format", directory: "apps/web" });

    expect(
      runCheck(nested, snapshot(projectConfig, tailwindManifest, "apps/web"), {}),
    ).toMatchObject({
      state: "pass",
      path: "apps/web/oxfmt.config.ts",
    });
  });
});
