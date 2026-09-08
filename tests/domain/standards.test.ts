import { describe, expect, it } from "vitest";
import {
  evaluateStandards,
  type StandardsSource,
} from "../../src/standards/evaluate";
import { mergePolicy, parsePolicy } from "../../src/standards/policy";
const policy = () => parsePolicy("baseline: shipshape/recommended@1");
function fixture(files: StandardsSource["files"] = {}): StandardsSource {
  return {
    repository: "octo/demo",
    commit: "a".repeat(40),
    files,
    complete: true,
    policy: policy(),
    policyState: "pass",
    collectedAt: "2026-09-07T00:00:00Z",
  };
}
function state(source: StandardsSource, rule: string) {
  return evaluateStandards(source).audit.checks.find(
    (check) => check.ruleId === `standards.${rule}`,
  )?.state;
}
const manifest = JSON.stringify({
  scripts: {
    "format:check": "oxfmt --check",
    lint: "oxlint",
    test: "vitest run",
    typecheck: "tsc --noEmit",
    check: "pnpm format:check && pnpm lint && pnpm test && pnpm typecheck",
  },
});
const workflow =
  "on: [pull_request]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm check\n";
describe("standards audit", () => {
  it("recognizes package scripts and recursive quality script wiring without claiming execution", () => {
    const source = fixture({
      "package.json": manifest,
      "tsconfig.json": '{/* jsonc */ "compilerOptions": {"strict": true,},}',
      "pnpm-lock.yaml": null,
      ".github/workflows/ci.yml": workflow,
    });
    for (const rule of [
      "format",
      "lint",
      "test",
      "typecheck",
      "lockfile",
      "strict",
      "ci-pr",
      "ci-gates",
    ])
      expect(state(source, rule)).toBe("pass");
    expect(evaluateStandards(source).limitations[0]).toContain(
      "never executed",
    );
  });
  it("does not mistake echo, comments, or disabled steps for CI wiring", () => {
    for (const run of ["echo pnpm check", "# pnpm check", "pnpm check || true"])
      expect(
        state(
          fixture({
            "package.json": manifest,
            ".github/workflows/ci.yml": workflow.replace("pnpm check", run),
          }),
          "ci-gates",
        ),
      ).toBe("unknown");
    expect(
      state(
        fixture({
          "package.json": manifest,
          ".github/workflows/ci.yml": workflow.replace(
            "- run:",
            "- if: false\n        run:",
          ),
        }),
        "ci-gates",
      ),
    ).toBe("unknown");
  });
  it("preserves unknown for inherited strictness and unreadable manifests", () => {
    expect(state(fixture({ "package.json": null }), "test")).toBe("unknown");
    expect(
      state(
        fixture({ "tsconfig.json": '{"extends":"@org/tsconfig"}' }),
        "strict",
      ),
    ).toBe("unknown");
    expect(
      state(
        fixture({
          "tsconfig.json":
            '{"extends":"./base.json", "compilerOptions":{"strict":false}}',
        }),
        "strict",
      ),
    ).toBe("fail");
  });
  it("does not treat an ancestor lockfile as confirmed workspace membership", () => {
    expect(
      state(
        fixture({ "apps/web/package.json": manifest, "pnpm-lock.yaml": null }),
        "lockfile",
      ),
    ).toBe("unknown");
  });
  it("retains package failures in the repository summary", () => {
    const result = evaluateStandards(
      fixture({ "apps/a/package.json": manifest, "apps/b/package.json": "{}" }),
    );
    expect(result.packages).toHaveLength(2);
    expect(
      result.audit.checks.find((check) => check.ruleId === "standards.test")
        ?.state,
    ).toBe("fail");
    expect(
      result.plan.items.some((item) => item.remediation.startsWith("apps/b:")),
    ).toBe(true);
  });
  it("only matches commands in the package working directory", () => {
    const source = fixture({
      "apps/a/package.json": manifest,
      ".github/workflows/ci.yml": workflow,
    });
    expect(state(source, "ci-gates")).toBe("unknown");
    source.files[".github/workflows/ci.yml"] = workflow.replace(
      "- run: pnpm check",
      "- run: pnpm check\n        working-directory: apps/a",
    );
    expect(state(source, "ci-gates")).toBe("pass");
  });
  it("handles Go and Python commands explicitly without inventing defaults", () => {
    const source = fixture({
      "go.mod": "module example.org/demo",
      "python/pyproject.toml": "[project]",
    });
    source.policy.packages = [
      {
        path: ".",
        commands: {
          lint: "go vet ./...",
          test: "go test -race ./...",
          format: "gofmt -l .",
        },
      },
    ];
    const result = evaluateStandards(source);
    expect(result.packages[0]?.profiles).toEqual(["go"]);
    expect(
      result.packages[0]?.audit.checks.find(
        (check) => check.ruleId === "standards.typecheck",
      )?.state,
    ).toBe("not_applicable");
    expect(result.packages[1]?.profiles).toEqual(["python"]);
    expect(state(source, "lockfile")).toBe("fail");
  });
  it("applies dated exceptions and exposes expired ones", () => {
    const source = fixture({ "package.json": "{}" });
    source.policy.exceptions = [
      {
        rule: "test",
        path: ".",
        reason: "Prototype awaiting implementation",
        expires: "2026-09-08",
      },
      {
        rule: "lint",
        path: ".",
        reason: "Temporary migration exception",
        expires: "2026-09-06",
      },
    ];
    expect(state(source, "test")).toBe("not_applicable");
    expect(state(source, "lint")).toBe("fail");
    expect(evaluateStandards(source).expiredExceptions).toHaveLength(1);
  });
  it("never turns incomplete discovery or unavailable shared policy into a clean pass", () => {
    const source = {
      ...fixture(),
      complete: false,
      policyState: "unknown" as const,
    };
    expect(
      evaluateStandards(source).audit.checks.every(
        (check) => check.state === "unknown",
      ),
    ).toBe(true);
    expect(evaluateStandards(source).complete).toBe(false);
  });
});
describe("shared policy boundary", () => {
  it("requires an immutable baseline and rejects unknown keys, traversal, and duplicate paths", () => {
    for (const text of [
      "baseline: latest",
      "baseline: shipshape/recommended@1\nwat: true",
      "baseline: shipshape/recommended@1\npackages:\n - path: ../bad\n   commands: {}",
      "baseline: shipshape/recommended@1\npackages:\n - path: .\n   commands: {}\n - path: .\n   commands: {}",
      "baseline: shipshape/recommended@1\nextends: {owner: octo, repo: demo, ref: main, path: policy.yml}",
    ])
      expect(() => parsePolicy(text)).toThrow();
  });
  it("merges commands and exceptions by exact package/rule identity", () => {
    const shared = policy();
    shared.packages = [
      { path: ".", commands: { test: "go test ./...", lint: "go vet ./..." } },
    ];
    const local = policy();
    local.packages = [{ path: ".", commands: { test: "go test -race ./..." } }];
    expect(mergePolicy(shared, local).packages[0]?.commands).toEqual({
      test: "go test -race ./...",
      lint: "go vet ./...",
    });
  });
  it("rejects nested inheritance", () => {
    const shared = policy();
    shared.extends = {
      owner: "octo",
      repo: "policy",
      ref: "a".repeat(40),
      path: "policy.yml",
    };
    expect(() => mergePolicy(shared, policy())).toThrow("cannot extend");
  });
});

it("keeps referenced TypeScript project strictness unknown", () => {
  expect(
    state(
      fixture({
        "tsconfig.json":
          '{"files":[],"references":[{"path":"./tsconfig.app.json"}]}',
      }),
      "strict",
    ),
  ).toBe("unknown");
});
