import { describe, expect, it } from "vitest";

import {
  dedupeEvidence,
  makeCheck,
  requireRuleDefinition,
  RULE_DEFINITIONS,
  RULE_IDS,
} from "../../src/domain/rules";
import { RULE_CATEGORIES, type Evidence } from "../../src/domain/types";

describe("rule catalog", () => {
  it("keeps stable identifiers unique and budgets each category to 100 points", () => {
    expect(new Set(RULE_IDS).size).toBe(RULE_IDS.length);
    expect(RULE_DEFINITIONS.map((rule) => rule.id)).toEqual([...RULE_IDS]);

    for (const category of RULE_CATEGORIES) {
      const total = RULE_DEFINITIONS.filter(
        (rule) => rule.category === category,
      ).reduce((sum, rule) => sum + rule.scoreImpact, 0);
      expect(total).toBe(100);
    }
  });

  it("builds checks from catalog metadata rather than caller-supplied metadata", () => {
    const check = makeCheck({
      ruleId: "public.readme",
      state: "fail",
      evidence: [
        {
          url: "https://github.com/example/project",
          label: "Repository",
        },
      ],
    });

    expect(check).toMatchObject({
      ruleId: "public.readme",
      category: "public_readiness",
      title: "README",
      state: "fail",
      confidence: "high",
      priority: "high",
      scoreImpact: 20,
    });
    expect(check.remediation).toContain("README");
    expect(check.evidence).toEqual([
      {
        url: "https://github.com/example/project",
        label: "Repository",
      },
    ]);
  });

  it("defaults unknown observations to low confidence and accepts a precise override", () => {
    expect(
      makeCheck({ ruleId: "security.secret-scanning", state: "unknown" }),
    ).toMatchObject({
      state: "unknown",
      confidence: "low",
    });

    expect(
      makeCheck({
        ruleId: "security.secret-scanning",
        state: "unknown",
        confidence: "medium",
        remediation: "Ask the repository owner to grant security read access.",
      }),
    ).toMatchObject({
      confidence: "medium",
      remediation: "Ask the repository owner to grant security read access.",
    });
  });

  it("rejects unknown rules and invalid runtime states", () => {
    expect(() => requireRuleDefinition("not-a-rule")).toThrowError(
      "Unknown rule identifier: not-a-rule",
    );
    expect(() =>
      makeCheck({
        ruleId: "public.readme",
        state: "pending" as never,
      }),
    ).toThrowError("Invalid check state: pending");
    expect(() =>
      makeCheck({
        ruleId: "public.readme",
        state: "pass",
        confidence: "certain" as never,
      }),
    ).toThrowError("Invalid confidence: certain");
  });
});

describe("evidence normalization", () => {
  it("filters unsafe URLs, deduplicates by URL, and sorts independent of input order", () => {
    const input: Evidence[] = [
      {
        url: "https://github.com/example/project/actions",
        label: "Zed label",
      },
      {
        url: "javascript:alert(1)",
        label: "unsafe",
      },
      {
        url: "https://github.com/example/project/readme",
        label: "README",
        detail: "The first detail",
      },
      {
        url: "https://github.com/example/project/actions",
        label: "Action runs",
        detail: "More useful detail",
      },
      {
        url: " https://github.com/example/project/readme ",
        label: "README",
        detail: "The first detail",
      },
      {
        url: "data:text/plain,secret",
        label: "unsafe",
      },
    ];

    expect(dedupeEvidence(input)).toEqual([
      {
        url: "https://github.com/example/project/actions",
        label: "Action runs",
        detail: "More useful detail",
      },
      {
        url: "https://github.com/example/project/readme",
        label: "README",
        detail: "The first detail",
      },
    ]);
    expect(dedupeEvidence([...input].reverse())).toEqual(dedupeEvidence(input));
  });

  it("uses the URL when a label is blank, trims long fields, and caps evidence", () => {
    const evidence = Array.from({ length: 12 }, (_, index) => ({
      url: "https://example.com/evidence/" + String(index).padStart(2, "0"),
      label: index === 0 ? "" : "x".repeat(200),
      detail: "d".repeat(400),
    }));

    const normalized = dedupeEvidence(evidence);
    expect(normalized).toHaveLength(8);
    expect(normalized[0]).toEqual({
      url: "https://example.com/evidence/00",
      label: "https://example.com/evidence/00",
      detail: "d".repeat(319) + "…",
    });
    expect(normalized[1]?.label).toBe("x".repeat(159) + "…");
  });

  it("canonicalizes equivalent absolute URLs before deduplicating", () => {
    expect(
      dedupeEvidence([
        { url: "HTTPS://EXAMPLE.COM", label: "uppercase" },
        { url: "https://example.com/", label: "canonical" },
      ]),
    ).toEqual([
      {
        url: "https://example.com/",
        label: "canonical",
      },
    ]);
  });

  it("ignores malformed runtime entries without making scoring unsafe", () => {
    expect(
      dedupeEvidence([
        null,
        undefined,
        { url: "not a URL", label: "bad" },
      ] as unknown as Evidence[]),
    ).toEqual([]);
  });
});
