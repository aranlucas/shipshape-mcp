import { describe, expect, it } from "vitest";

import { makeCheck } from "../../src/domain/rules";
import {
  buildActionPlan,
  categoryRollup,
  normalizeChecks,
  scoreChecks,
} from "../../src/domain/scoring";
import type { CheckResult } from "../../src/domain/types";

describe("scoreChecks", () => {
  it("returns a transparent weighted score and category rollups", () => {
    const checks = [
      makeCheck({ ruleId: "public.description", state: "pass" }),
      makeCheck({
        ruleId: "public.readme",
        state: "fail",
        evidence: [
          {
            url: "https://github.com/example/project",
            label: "Repository",
          },
        ],
      }),
      makeCheck({
        ruleId: "public.license",
        state: "unknown",
        confidence: "medium",
      }),
      makeCheck({ ruleId: "public.homepage", state: "not_applicable" }),
      makeCheck({ ruleId: "security.secret-scanning", state: "fail" }),
      makeCheck({ ruleId: "security.push-protection", state: "pass" }),
    ];

    const summary = scoreChecks(checks);

    expect(summary).toMatchObject({
      score: 53,
      checkCount: 6,
      totalImpact: 90,
      failedImpact: 42,
      observedImpact: 70,
      confidence: "medium",
      counts: {
        pass: 2,
        fail: 2,
        unknown: 1,
        not_applicable: 1,
      },
    });
    expect(summary.checks.map((check) => check.ruleId)).toEqual([
      "public.description",
      "public.homepage",
      "public.license",
      "public.readme",
      "security.push-protection",
      "security.secret-scanning",
    ]);
    expect(summary.categories).toEqual([
      {
        category: "public_readiness",
        score: 60,
        checkCount: 4,
        counts: {
          pass: 1,
          fail: 1,
          unknown: 1,
          not_applicable: 1,
        },
        totalImpact: 50,
        failedImpact: 20,
        observedImpact: 30,
        confidence: "medium",
      },
      {
        category: "security_posture",
        score: 45,
        checkCount: 2,
        counts: {
          pass: 1,
          fail: 1,
          unknown: 0,
          not_applicable: 0,
        },
        totalImpact: 40,
        failedImpact: 22,
        observedImpact: 40,
        confidence: "high",
      },
    ]);
  });

  it("does not penalize unknown observations, but lowers confidence", () => {
    const summary = scoreChecks([
      makeCheck({ ruleId: "public.readme", state: "unknown" }),
      makeCheck({ ruleId: "public.license", state: "pass" }),
    ]);

    expect(summary.score).toBe(100);
    expect(summary.failedImpact).toBe(0);
    expect(summary.totalImpact).toBe(40);
    expect(summary.observedImpact).toBe(20);
    expect(summary.confidence).toBe("low");
  });

  it("returns null when every observation is not applicable", () => {
    const summary = scoreChecks([
      makeCheck({ ruleId: "public.homepage", state: "not_applicable" }),
      makeCheck({ ruleId: "public.topics", state: "not_applicable" }),
    ]);

    expect(summary.score).toBeNull();
    expect(summary.totalImpact).toBe(0);
    expect(summary.failedImpact).toBe(0);
    expect(summary.observedImpact).toBe(0);
    expect(summary.confidence).toBe("low");
    expect(summary.categories[0]).toMatchObject({
      category: "public_readiness",
      score: null,
      totalImpact: 0,
    });
  });

  it("is empty and deterministic for an empty input", () => {
    expect(scoreChecks([])).toEqual({
      score: null,
      checkCount: 0,
      counts: {
        pass: 0,
        fail: 0,
        unknown: 0,
        not_applicable: 0,
      },
      totalImpact: 0,
      failedImpact: 0,
      observedImpact: 0,
      confidence: "low",
      checks: [],
      categories: [],
    });
  });
});

describe("normalizeChecks", () => {
  it("deduplicates conservatively and repairs mutable provider metadata", () => {
    const pass = makeCheck({
      ruleId: "public.readme",
      state: "pass",
      confidence: "high",
    });
    const spoofedFail: CheckResult = {
      ...pass,
      category: "security_posture",
      title: "Spoofed",
      state: "fail",
      confidence: "low",
      scoreImpact: 99,
      priority: "low",
      remediation: "",
    };

    expect(normalizeChecks([pass, spoofedFail])).toEqual([
      {
        ...pass,
        state: "fail",
        confidence: "low",
        remediation: expect.stringContaining("README"),
      },
    ]);
    expect(normalizeChecks([spoofedFail, pass])).toEqual(
      normalizeChecks([pass, spoofedFail]),
    );
  });

  it("prefers unknown over pass and stronger confidence on state ties", () => {
    const pass = makeCheck({
      ruleId: "security.code-scanning",
      state: "pass",
      confidence: "high",
    });
    const unknown = makeCheck({
      ruleId: "security.code-scanning",
      state: "unknown",
      confidence: "low",
    });
    expect(normalizeChecks([pass, unknown])[0]?.state).toBe("unknown");

    const medium = makeCheck({
      ruleId: "public.description",
      state: "fail",
      confidence: "medium",
    });
    const high = makeCheck({
      ruleId: "public.description",
      state: "fail",
      confidence: "high",
    });
    expect(normalizeChecks([medium, high])[0]?.confidence).toBe("high");
  });

  it("does not mutate the caller's array", () => {
    const checks = [
      makeCheck({ ruleId: "security.security-policy", state: "pass" }),
      makeCheck({ ruleId: "public.readme", state: "pass" }),
    ];
    const original = [...checks];
    normalizeChecks(checks);
    expect(checks).toEqual(original);
  });
});

describe("buildActionPlan", () => {
  const actionable = [
    makeCheck({
      ruleId: "public.homepage",
      state: "fail",
      confidence: "low",
    }),
    makeCheck({ ruleId: "public.readme", state: "fail" }),
    makeCheck({
      ruleId: "branch.default-protection",
      state: "unknown",
    }),
    makeCheck({ ruleId: "security.push-protection", state: "fail" }),
    makeCheck({ ruleId: "security.code-scanning", state: "fail" }),
    makeCheck({ ruleId: "public.license", state: "pass" }),
    makeCheck({
      ruleId: "public.topics",
      state: "not_applicable",
    }),
  ];

  it("ranks failures before unknowns by priority, impact, and stable ID", () => {
    const plan = buildActionPlan(actionable);

    expect(plan.items.map((item) => item.ruleId)).toEqual([
      "security.push-protection",
      "public.readme",
      "security.code-scanning",
      "public.homepage",
      "branch.default-protection",
    ]);
    expect(plan.items.map((item) => item.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(plan.omittedCount).toBe(0);
    expect(
      plan.items.every(
        (item) => item.state === "fail" || item.state === "unknown",
      ),
    ).toBe(true);
  });

  it("caps results, supports zero, and reports omitted work", () => {
    expect(buildActionPlan(actionable, { maxItems: 3 })).toMatchObject({
      omittedCount: 2,
      items: [
        { rank: 1, ruleId: "security.push-protection" },
        { rank: 2, ruleId: "public.readme" },
        { rank: 3, ruleId: "security.code-scanning" },
      ],
    });
    expect(buildActionPlan(actionable, { maxItems: 0 })).toEqual({
      items: [],
      omittedCount: 5,
    });
    expect(
      buildActionPlan(actionable, { maxItems: Number.POSITIVE_INFINITY }).items,
    ).toHaveLength(5);
  });
});

describe("categoryRollup", () => {
  it("filters to the requested category and returns an empty rollup when absent", () => {
    const checks = [
      makeCheck({ ruleId: "public.readme", state: "fail" }),
      makeCheck({ ruleId: "security.secret-scanning", state: "pass" }),
    ];

    expect(categoryRollup("public_readiness", checks)).toMatchObject({
      category: "public_readiness",
      score: 0,
      checkCount: 1,
      failedImpact: 20,
    });
    expect(categoryRollup("branch_risk", checks)).toEqual({
      category: "branch_risk",
      score: null,
      checkCount: 0,
      counts: {
        pass: 0,
        fail: 0,
        unknown: 0,
        not_applicable: 0,
      },
      totalImpact: 0,
      failedImpact: 0,
      observedImpact: 0,
      confidence: "low",
    });
  });
});
