import { describe, expect, it } from "vitest";
import { evaluateStandards, type StandardsSource } from "@/standards/evaluate";
import { mergePolicy, parsePolicy } from "@/standards/policy";
import { inspectLintCommand } from "@/standards/lint-command";
import { inspectLintConfig } from "@/standards/lint-config";

const preset = "./node_modules/@aranlucas/oxforge/configs/recommended.json";

const policyText =
  "baseline: shipshape/recommended@1\nconvergence: {profile: oxforge@1, version: 0.2.2}";

const manifest = (lint = "oxlint", version = "0.2.2") =>
  JSON.stringify({ devDependencies: { "@aranlucas/oxforge": version }, scripts: { lint } });

const config = (extension = preset) => JSON.stringify({ extends: [extension] });

function source(files: StandardsSource["files"] = {}): StandardsSource {
  return {
    repository: "octo/demo",
    commit: "a".repeat(40),
    files: { "package.json": manifest(), ".oxlintrc.json": config(), ...files },
    complete: true,
    policy: parsePolicy(policyText),
    policyState: "pass",
    collectedAt: "2026-10-14T00:00:00Z",
  };
}

function check(input: StandardsSource, name: string) {
  return evaluateStandards(input).audit.checks.find(
    (item) => item.ruleId === `standards.oxforge-${name}`,
  );
}

describe("opt-in Oxforge convergence", () => {
  it("preserves the existing baseline when the profile is absent", () => {
    const input = source();
    input.policy = parsePolicy("baseline: shipshape/recommended@1");
    const result = evaluateStandards(input);
    expect(result.audit.checks).toHaveLength(10);
    expect(result.audit.totalImpact).toBe(90);
    expect(result).not.toHaveProperty("convergence");
  });

  it("reports exact declarations and static wiring without claiming execution", () => {
    for (const lint of [
      "oxlint",
      "oxlint .",
      "pnpm exec oxlint --type-aware",
      "npm exec -- oxlint --deny-warnings",
      "oxlint -c .oxlintrc.json",
      "oxlint --config=./.oxlintrc.json",
    ]) {
      const input = source({ "package.json": manifest(lint) });

      for (const name of ["version", "lint", "legacy"]) {
        expect(check(input, name)?.state).toBe("pass");
      }

      expect(check(input, "lint")?.remediation).toContain("execution are not verified");
    }
  });

  it("follows bounded script aliases and JSONC parent extends", () => {
    const input = source({
      "package.json": JSON.stringify({
        scripts: {
          lint: "pnpm lint:code",
          "lint:code": "npm run lint:strict",
          "lint:strict": "oxlint",
        },
        devDependencies: { "@aranlucas/oxforge": "0.2.2" },
      }),
      ".oxlintrc.json": '{/* policy */ "extends": ["./config/oxlint.json"],}',
      "config/oxlint.json": config(`../${preset.slice(2)}`),
    });

    expect(check(input, "lint")?.state).toBe("pass");
  });

  it("separates missing and mismatched versions from unresolved declarations", () => {
    expect(check(source({ "package.json": "{}" }), "version")?.state).toBe("fail");
    expect(check(source({ "package.json": manifest("oxlint", "0.1.3") }), "version")?.state).toBe(
      "fail",
    );

    for (const version of ["^0.2.2", "~0.2.2", "catalog:", "workspace:*", "latest"]) {
      expect(check(source({ "package.json": manifest("oxlint", version) }), "version")?.state).toBe(
        "unknown",
      );
    }

    expect(check(source({ "package.json": null }), "version")?.state).toBe("unknown");
    expect(
      check(
        source({
          "package.json": JSON.stringify({
            dependencies: { "@aranlucas/oxforge": "0.2.2" },
            devDependencies: { "@aranlucas/oxforge": "0.1.3" },
          }),
        }),
        "version",
      )?.state,
    ).toBe("unknown");
  });

  it("does not infer workspace dependency provision and retains per-package plans", () => {
    const input = source({
      "apps/web/package.json": "{}",
      "apps/api/package.json": manifest("oxlint", "0.1.3"),
    });

    const result = evaluateStandards(input);
    const web = result.packages.find((pkg) => pkg.path === "apps/web");
    expect(
      web?.audit.checks.find((item) => item.ruleId === "standards.oxforge-version")?.state,
    ).toBe("unknown");
    expect(web?.plan?.items.some((item) => item.ruleId === "standards.oxforge-version")).toBe(true);
    expect(
      result.plan.items.some(
        (item) =>
          item.ruleId === "standards.oxforge-version" && item.remediation.startsWith("apps/api:"),
      ),
    ).toBe(true);
  });

  it("does not mistake installed dependencies, plugins, comments, or framework-only presets for base wiring", () => {
    for (const text of [
      "{}",
      '{"jsPlugins":["@aranlucas/oxlint-plugin-anti-slop"]}',
      `{// ${preset}\n}`,
      config("./node_modules/@aranlucas/oxforge/configs/react.json"),
    ]) {
      expect(check(source({ ".oxlintrc.json": text }), "lint")?.state).toBe("fail");
    }

    expect(
      check(
        source({ ".oxlintrc.json": config("@aranlucas/oxforge/configs/recommended.json") }),
        "lint",
      )?.state,
    ).toBe("unknown");
  });

  it("does not mistake shell wrappers, disabled lint, or introspection for enforcement", () => {
    for (const lint of [
      "echo oxlint",
      "# oxlint",
      "oxlint || true",
      "if true; then oxlint; fi",
      "cd app && oxlint",
      "oxlint --print-config",
      "oxlint --help",
      "oxlint --config",
      "oxlint --config=.oxlintrc.json --config=other.json",
      "oxlint && exit 0",
      "oxlint --disable-nested-config",
    ]) {
      expect(check(source({ "package.json": manifest(lint) }), "lint")?.state).toBe("unknown");
    }

    expect(
      check(source({ "package.json": JSON.stringify({ scripts: { lint: "pnpm lint" } }) }), "lint")
        ?.state,
    ).toBe("unknown");
  });

  it("uses the selected config rather than an unrelated valid default", () => {
    const input = source({
      "package.json": manifest("oxlint --config config/oxlint.json"),
      "config/oxlint.json": "{}",
    });

    expect(check(input, "lint")?.state).toBe("fail");
    input.files["config/oxlint.json"] = null;
    expect(check(input, "lint")?.state).toBe("unknown");
    expect(evaluateStandards(input).complete).toBe(false);
  });

  it("keeps dynamic, ambiguous, malformed, cyclic, and partially readable config unknown", () => {
    const cases: StandardsSource["files"][] = [
      { ".oxlintrc.json": null },
      { ".oxlintrc.json": "[]" },
      { ".oxlintrc.json": "{broken" },
      { ".oxlintrc.json": config("./.oxlintrc.json") },
      {
        ".oxlintrc.json": JSON.stringify({ extends: [preset, "./unreadable.json"] }),
        "unreadable.json": null,
      },
      { "oxlint.config.ts": "export default { extends: [oxforge()] };" },
    ];

    for (const changes of cases) {
      expect(check(source(changes), "lint")?.state).toBe("unknown");
    }

    const dynamic = source({
      "package.json": manifest("oxlint -c oxlint.config.ts"),
      "oxlint.config.ts": "throw new Error('never execute')",
    });

    expect(check(dynamic, "lint")?.state).toBe("unknown");
    expect(check(dynamic, "legacy")?.state).toBe("unknown");
  });

  it("flags only referenced repository-local anti-slop plugins, retaining legitimate overrides", () => {
    for (const plugin of [
      "./scripts/anti-slop.mjs",
      { name: "anti-slop", specifier: "./scripts/anti-slop.mjs" },
    ]) {
      const input = source({
        ".oxlintrc.json": JSON.stringify({ extends: [preset], jsPlugins: [plugin] }),
        "scripts/anti-slop.mjs": null,
      });

      expect(check(input, "legacy")?.state).toBe("fail");
      expect(check(input, "legacy")?.evidence[0]?.url).toContain(
        `/blob/${input.commit}/.oxlintrc.json`,
      );
    }

    const input = source({
      ".oxlintrc.json": JSON.stringify({
        extends: [preset],
        jsPlugins: ["@aranlucas/oxlint-plugin-anti-slop"],
        rules: { "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }] },
      }),
      "unused/anti-slop.mjs": null,
    });

    expect(check(input, "legacy")?.state).toBe("pass");
  });

  it("inspects override plugin references and leaves invalid config structure unknown", () => {
    const input = source({
      ".oxlintrc.json": JSON.stringify({
        extends: [preset],
        overrides: [
          {
            files: ["**/*.ts"],
            jsPlugins: [{ name: "anti-slop", specifier: "./tools/local-plugin.mjs" }],
          },
        ],
      }),
    });

    expect(check(input, "legacy")?.state).toBe("fail");
    input.files[".oxlintrc.json"] = JSON.stringify({ extends: [preset], overrides: "broken" });
    expect(check(input, "legacy")?.state).toBe("unknown");
    expect(check(input, "lint")?.state).toBe("unknown");
  });

  it("keeps truncated discovery and unavailable shared policy uncertain", () => {
    const input = source();
    input.complete = false;
    expect(check(input, "lint")?.state).toBe("unknown");
    input.policyState = "unknown";
    expect(check(input, "version")?.state).toBe("unknown");
  });

  it("does not apply Node checks to Go packages", () => {
    const input = source();
    input.files = { "go.mod": "module example.org/demo" };

    for (const name of ["version", "lint", "legacy"]) {
      expect(check(input, name)?.state).toBe("not_applicable");
    }
  });

  it("deduplicates repeated branches and bounds total expansion", () => {
    const files: StandardsSource["files"] = {};

    for (let index = 0; index < 8; index++) {
      files[`config${index}.json`] = JSON.stringify({
        extends: [`./config${index + 1}.json`, `./config${index + 1}.json`],
      });
    }

    files["config8.json"] = config();
    const graph = inspectLintConfig(files, "config0.json", true);
    expect(graph.paths).toHaveLength(9);
    expect(graph.uncertain).toBe(false);
    const limited = inspectLintConfig(files, "config0.json", true, new Set(), { remaining: 3 });
    expect(limited.uncertain).toBe(true);
    expect(limited.paths.length).toBeLessThanOrEqual(3);
    const scripts = { lint: "pnpm child && pnpm child", child: "oxlint" };
    expect(inspectLintCommand("pnpm lint", scripts).configs).toEqual([null]);
    expect(inspectLintCommand("pnpm lint", scripts, new Set(), { remaining: 1 }).uncertain).toBe(
      true,
    );
  });

  it("caps config traversal and rejects repository escape paths", () => {
    const files: StandardsSource["files"] = {};

    for (let index = 0; index < 20; index++) {
      files[`config${index}.json`] = config(`./config${index + 1}.json`);
    }

    expect(inspectLintConfig(files, "config0.json", true).uncertain).toBe(true);
    expect(check(source({ ".oxlintrc.json": config("../outside.json") }), "lint")?.state).toBe(
      "unknown",
    );
  });
});

describe("convergence policy", () => {
  it("inherits shared profile settings and permits explicit local replacement", () => {
    const shared = parsePolicy(policyText);
    const local = parsePolicy("baseline: shipshape/recommended@1");
    expect(mergePolicy(shared, local).convergence).toEqual(shared.convergence);
    local.convergence = { profile: "oxforge@1", version: "0.3.0" };
    expect(mergePolicy(shared, local).convergence?.version).toBe("0.3.0");
  });

  it("rejects floating policy versions, unsupported profiles, and unknown settings", () => {
    for (const fragment of [
      "{profile: oxforge@1, version: latest}",
      "{profile: oxforge@1, version: ^0.2.2}",
      "{profile: oxforge@2, version: 0.2.2}",
      "{profile: oxforge@1, version: 0.2.2, execute: true}",
    ]) {
      expect(() =>
        parsePolicy(`baseline: shipshape/recommended@1\nconvergence: ${fragment}`),
      ).toThrow("Invalid .shipshape.yml");
    }
  });

  it("applies dated exceptions to convergence checks", () => {
    const input = source({ "package.json": "{}" });
    input.policy.exceptions.push({
      rule: "oxforge-version",
      path: ".",
      reason: "Migration awaiting released tooling",
      expires: "2026-10-15",
    });
    expect(check(input, "version")?.state).toBe("not_applicable");
  });
});
