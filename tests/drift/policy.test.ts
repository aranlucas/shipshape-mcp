import { describe, expect, it } from "vitest";
import {
  DriftPolicySchema,
  globMatches,
  parseDriftPolicy,
  ruleSelects,
} from "../../src/drift/policy";
import { GitHubInputError } from "../../src/github/client";

describe("settings policy", () => {
  it("parses YAML rules and applies selector defaults", () => {
    const policy = parseDriftPolicy(`
version: 1
rules:
  - id: squash-only
    repositories:
      include: ["svc-*"]
    merge:
      allowSquash: true
      allowMergeCommit: false
`);

    expect(policy.rules[0]).toMatchObject({
      id: "squash-only",
      repositories: {
        include: ["svc-*"],
        exclude: [],
        forks: false,
        archived: false,
      },
      merge: { allowSquash: true, allowMergeCommit: false },
    });
  });

  it.each([
    [
      "an unknown field",
      "version: 1\nrules:\n  - id: a\n    merge: {squash: true}",
    ],
    ["a rule without settings", "version: 1\nrules:\n  - id: empty"],
    [
      "duplicate ids",
      "version: 1\nrules:\n  - id: a\n    features: {wiki: false}\n  - id: a\n    features: {wiki: false}",
    ],
    [
      "a regex selector",
      "version: 1\nrules:\n  - id: a\n    repositories: {include: ['^(a+)+$']}\n    features: {wiki: false}",
    ],
    [
      "a topic both required and forbidden",
      "version: 1\nrules:\n  - id: a\n    topics: {required: [x], forbidden: [x]}",
    ],
    [
      "a branch without settings",
      "version: 1\nrules:\n  - id: a\n    branchProtection: {branch: main}",
    ],
  ])("rejects %s with an actionable input error", (_name, text) => {
    expect(() => parseDriftPolicy(text)).toThrow(GitHubInputError);
  });

  it("matches repository globs case-insensitively in linear time", () => {
    expect(globMatches("svc-*", "svc-api")).toBe(true);
    expect(globMatches("svc-*", "SVC-api")).toBe(true);
    expect(globMatches("svc-?", "svc-ab")).toBe(false);
    expect(globMatches("*-api", "billing-api")).toBe(true);
    expect(globMatches("*a*b*", "xxaxxbxx")).toBe(true);
    expect(globMatches("*a*b", "xxaxxbxx")).toBe(false);
    expect(globMatches("*", "")).toBe(true);

    const started = performance.now();
    expect(globMatches(`${"*a".repeat(50)}b`, "a".repeat(100))).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("selects repositories by include, exclude, fork, and archive scope", () => {
    const [rule] = DriftPolicySchema.parse({
      version: 1,
      rules: [
        {
          id: "services",
          repositories: { include: ["svc-*"], exclude: ["svc-sandbox"] },
          features: { wiki: false },
        },
      ],
    }).rules;

    const repo = (name: string, fork = false, archived = false) => ({
      name,
      fork,
      archived,
    });

    expect(rule && ruleSelects(rule, repo("svc-api"))).toBe(true);
    expect(rule && ruleSelects(rule, repo("svc-sandbox"))).toBe(false);
    expect(rule && ruleSelects(rule, repo("web"))).toBe(false);
    expect(rule && ruleSelects(rule, repo("svc-api", true))).toBe(false);
    expect(rule && ruleSelects(rule, repo("svc-api", false, true))).toBe(false);
  });
});
