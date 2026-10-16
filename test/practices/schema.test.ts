import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CheckSchema,
  checkLabel,
  parsePractice,
  type BRANCH_PROTECTION_KEYS,
  type Check,
} from "../../src/practices/schema";

type BranchCheck = Extract<Check, { type: "branch-protection" }>;

type PathCheck = Extract<Check, { type: "json-path" | "yaml-path" }>;

type JsonPathCheck = Extract<Check, { type: "json-path" }>;

type YamlPathCheck = Extract<Check, { type: "yaml-path" }>;

type ReviewCountCheck = Extract<BranchCheck, { key: "requiredApprovingReviews" }>;

type StatusChecksCheck = Extract<BranchCheck, { key: "requiredStatusChecks" }>;

type ExistencePredicate = Extract<PathCheck["predicate"], { kind: "exists" }>;

const fixture = `
version: 1
id: husky-lint-staged
title: Pre-commit hooks with husky + lint-staged
summary: One line shown in the grid tooltip.
kind: files
appliesTo:
  owners: [aranlucas, sidequest-labs]
  languages: [TypeScript, JavaScript]
  hasFiles: [package.json]
  include: ["*"]
  exclude: ["legacy-*"]
  archived: false
  forks: false
checks:
  - type: file-exists
    path: .husky/pre-commit
  - type: file-matches
    path: .husky/pre-commit
    source: files/.husky/pre-commit
  - type: file-contains
    path: .github/workflows/ci.yml
    text: "uses: pnpm/setup@"
  - type: json-path
    file: package.json
    path: scripts.prepare
    equals: husky
  - type: yaml-path
    file: .github/dependabot.yml
    path: multi-ecosystem-groups.weekly-dependencies.schedule.day
    equals: thursday
  - type: dependency
    file: package.json
    name: "@aranlucas/oxforge"
    version: "0.2.2"
  - type: setting
    key: allow_squash_merge
    equals: true
  - type: setting
    key: security_and_analysis.secret_scanning.status
    equals: enabled
  - type: branch-protection
    key: required_linear_history
    equals: true
  - type: workflow
    check: pinned-actions
`;

function issuesOf(result: ReturnType<typeof parsePractice>) {
  if (result.ok) {
    throw new Error("expected practice validation to fail");
  }

  return result.issues;
}

function practiceOf(result: ReturnType<typeof parsePractice>) {
  if (!result.ok) {
    throw new Error("expected practice to parse");
  }

  return result.practice;
}

describe("practice schema", () => {
  it("parses every seed check type", () => {
    const result = parsePractice(fixture, "husky-lint-staged");
    expect(result.ok).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.ok ? result.practice.checks : []).toHaveLength(10);
  });

  it("reports discriminator typos at checks.N.type", () => {
    const result = parsePractice(fixture.replace("file-exists", "file-exist"));
    expect(result).toMatchObject({ ok: false, issues: [{ path: "checks.0.type" }] });
  });

  it("reports unknown top-level keys at the key", () => {
    const result = parsePractice(`${fixture}\nextra: true`);
    expect(result).toMatchObject({ ok: false, issues: [{ path: "extra" }] });
  });

  it("validates ids and expected folder ids", () => {
    expect(parsePractice(fixture.replace("husky-lint-staged", "Husky_Lint"))).toMatchObject({
      ok: false,
      issues: [{ path: "id" }],
    });
    expect(parsePractice(fixture.replace("husky-lint-staged", "other"), "husky")).toMatchObject({
      ok: false,
      issues: [{ path: "id", message: 'id must match its folder name "husky"' }],
    });
  });

  it("requires exactly one json/yaml path condition", () => {
    const result = parsePractice(fixture.replace("    equals: husky\n", ""));
    expect(result.ok).toBe(false);
    expect(issuesOf(result).find((issue) => issue.path === "checks.3")).toBeTruthy();
  });

  it.each(["json-path", "yaml-path"])(
    "normalizes %s predicates without changing YAML fields",
    (type) => {
      const base = { type, file: "config.json", path: "enabled" };

      expect(CheckSchema.parse({ ...base, equals: false })).toEqual({
        ...base,
        predicate: { kind: "equals", value: false },
      });
      expect(CheckSchema.parse({ ...base, exists: false })).toEqual({
        ...base,
        predicate: { kind: "exists", value: false },
      });
      expect(CheckSchema.safeParse(base).success).toBe(false);
      expect(CheckSchema.safeParse({ ...base, equals: false, exists: false }).success).toBe(false);
    },
  );

  it.each([
    { key: "requiredApprovingReviews", equals: true },
    { key: "requiredApprovingReviews", equals: -1 },
    { key: "requiredApprovingReviews", equals: 1.5 },
    { key: "requiredStatusChecks", equals: true },
    { key: "requiredStatusChecks", equals: [""] },
    { key: "enforceAdmins", equals: 1 },
    { key: "notAProtectionKey", equals: true },
  ])("rejects incompatible branch-protection expectations $key = $equals", (check) => {
    expect(CheckSchema.safeParse({ type: "branch-protection", ...check }).success).toBe(false);
  });

  it("preserves key and expected-value relationships in TypeScript", () => {
    expectTypeOf<BranchCheck["key"]>().toEqualTypeOf<(typeof BRANCH_PROTECTION_KEYS)[number]>();
    expectTypeOf<ReviewCountCheck["equals"]>().toEqualTypeOf<number>();
    expectTypeOf<StatusChecksCheck["equals"]>().toEqualTypeOf<string[]>();
    expectTypeOf<ExistencePredicate["value"]>().toEqualTypeOf<boolean>();
    expectTypeOf<JsonPathCheck["type"]>().toEqualTypeOf<"json-path">();
    expectTypeOf<YamlPathCheck["type"]>().toEqualTypeOf<"yaml-path">();

    expect(
      CheckSchema.parse({
        type: "branch-protection",
        key: "required_linear_history",
        equals: true,
      }),
    ).toEqual({ type: "branch-protection", key: "requiredLinearHistory", equals: true });
  });

  it("validates file match sources", () => {
    const result = parsePractice(fixture.replace("files/.husky/pre-commit", "../secret"));
    expect(result.ok).toBe(false);
    expect(issuesOf(result).some((issue) => issue.path === "checks.1.source")).toBe(true);
  });

  it("returns one issue for malformed yaml", () => {
    const result = parsePractice("version: [");
    expect(result).toMatchObject({ ok: false, id: null, issues: [{ path: "" }] });
    expect(issuesOf(result)[0]?.message.startsWith("Invalid YAML")).toBe(true);
  });

  it("restricts settings practices to settings checks", () => {
    const result = parsePractice(fixture.replace("kind: files", "kind: settings"));
    expect(result.ok).toBe(false);
    expect(issuesOf(result)).toContainEqual({
      path: "checks.0",
      message: "settings practices may only use setting and branch-protection checks",
    });
  });

  it("labels checks for the dashboard", () => {
    const result = parsePractice(fixture);
    expect(result.ok).toBe(true);
    const practice = practiceOf(result);
    expect(checkLabel(practice.checks[0])).toBe(".husky/pre-commit exists");
    expect(checkLabel(practice.checks[3])).toBe("package.json scripts.prepare = husky");
    expect(checkLabel(practice.checks[5])).toBe("@aranlucas/oxforge declared at 0.2.2");
    expect(checkLabel(practice.checks[6])).toBe("allow_squash_merge = true");
    expect(checkLabel(practice.checks[9])).toBe("Actions pinned to full commit SHAs");
  });
});
