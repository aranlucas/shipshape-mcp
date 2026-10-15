import { describe, expect, it } from "vitest";
import { runCheck } from "@/practices/checks";
import { CheckSchema } from "@/practices/schema";
import { makeSnapshot } from "@test/helpers/snapshot";

const oxforge = CheckSchema.parse({ type: "oxforge" });

const preset = "./node_modules/@aranlucas/oxforge/configs/recommended.json";

function lintSnapshot(config: string, version = "^0.2.2") {
  const files = {
    "package.json": JSON.stringify({ devDependencies: { "@aranlucas/oxforge": version } }),
    ".oxlintrc.json": config,
  };

  return makeSnapshot({ files, paths: Object.keys(files) });
}

describe("semantic Oxforge inspection", () => {
  it("accepts newer compatible declarations and inherited shared configs", () => {
    const snapshot = lintSnapshot(JSON.stringify({ extends: ["./config/base.json"] }), "0.3.0");
    snapshot.tree?.paths.add("config/base.json");
    snapshot.files.set("config/base.json", JSON.stringify({ extends: [`../${preset}`] }));
    expect(runCheck(oxforge, snapshot, {}).state).toBe("pass");
  });

  it.each(["0.1.9", "^0.1.0"])("rejects old declared lower bound %s", (version) => {
    expect(
      runCheck(oxforge, lintSnapshot(JSON.stringify({ extends: [preset] }), version), {}).state,
    ).toBe("fail");
  });

  it.each(["catalog:", "workspace:*", "latest", "0.2.2-beta.1"])(
    "does not guess unresolved version %s",
    (version) => {
      expect(
        runCheck(oxforge, lintSnapshot(JSON.stringify({ extends: [preset] }), version), {}).state,
      ).toBe("unknown");
    },
  );

  it("rejects framework-only configs and local anti-slop plugins", () => {
    expect(
      runCheck(
        oxforge,
        lintSnapshot(JSON.stringify({ extends: [preset.replace("recommended", "tailwind")] })),
        {},
      ).state,
    ).toBe("fail");
    expect(
      runCheck(
        oxforge,
        lintSnapshot(
          JSON.stringify({
            extends: [preset],
            jsPlugins: [{ name: "anti-slop", specifier: "./scripts/plugin.js" }],
          }),
        ),
        {},
      ).state,
    ).toBe("fail");
  });

  it("does not accept a preset mentioned only in a comment", () => {
    expect(runCheck(oxforge, lintSnapshot(`{/* ${preset} */}`), {}).state).toBe("fail");
  });

  it("preserves unknown for unread inheritance, cycles, dynamic configs and truncated trees", () => {
    const snapshot = lintSnapshot(JSON.stringify({ extends: ["./config/base.json"] }));
    snapshot.tree?.paths.add("config/base.json");
    expect(runCheck(oxforge, snapshot, {}).state).toBe("unknown");
    snapshot.files.set("config/base.json", JSON.stringify({ extends: ["../.oxlintrc.json"] }));
    expect(runCheck(oxforge, snapshot, {}).state).toBe("unknown");
    snapshot.tree?.paths.delete(".oxlintrc.json");
    snapshot.tree?.paths.add("oxlint.config.ts");
    snapshot.files.set("oxlint.config.ts", "export default {};");
    expect(runCheck(oxforge, snapshot, {}).state).toBe("unknown");
    const truncated = lintSnapshot(JSON.stringify({ extends: [preset] }));

    if (truncated.tree) {
      truncated.tree.truncated = true;
    }

    expect(runCheck(oxforge, truncated, {}).state).toBe("unknown");
  });
});

const dependabot = CheckSchema.parse({ type: "dependabot-grouped" });

function groupedConfig(group = "weekly", limit = 1) {
  return JSON.stringify({
    version: 2,
    "multi-ecosystem-groups": { weekly: { "open-pull-requests-limit": limit } },
    updates: [
      {
        "package-ecosystem": "npm",
        directory: "/",
        "multi-ecosystem-group": "weekly",
        patterns: ["*"],
      },
      {
        "package-ecosystem": "github-actions",
        directory: "/",
        "multi-ecosystem-group": group,
        patterns: ["*"],
      },
    ],
  });
}

function groupedResult(content: string) {
  const path = ".github/dependabot.yml";

  return runCheck(dependabot, makeSnapshot({ paths: [path], files: { [path]: content } }), {});
}

describe("semantic Dependabot grouping", () => {
  it("checks actual group membership and the one-PR limit", () => {
    expect(groupedResult(groupedConfig()).state).toBe("pass");
    expect(groupedResult(groupedConfig("other")).state).toBe("fail");
    expect(groupedResult(groupedConfig("weekly", 5)).state).toBe("fail");
    expect(
      groupedResult("multi-ecosystem-groups: {weekly: {schedule: {interval: weekly}}}").state,
    ).toBe("fail");
  });
  it("does not pass invalid manifests or unverified ecosystems", () => {
    expect(groupedResult(groupedConfig().replace('"version":2', '"version":1')).state).toBe("fail");
    expect(groupedResult(groupedConfig().replaceAll('"directory":"/",', "")).state).toBe("fail");
    expect(groupedResult(groupedConfig().replace('"npm"', '"pip"')).state).toBe("unknown");
  });

  it("keeps malformed and unread configuration unknown", () => {
    expect(groupedResult("updates: [").state).toBe("unknown");
    expect(runCheck(dependabot, makeSnapshot({ tree: null }), {}).state).toBe("unknown");
  });
});
