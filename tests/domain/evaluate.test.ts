import { describe, expect, it } from "vitest";

import {
  evaluateDeliveryHygiene,
  evaluateRepositoryReadiness,
} from "../../src/domain/evaluate";
import { scoreChecks } from "../../src/domain/scoring";
import type { RepositoryReadiness } from "../../src/github/schemas";

const collectedAt = "2026-08-30T20:00:00.000Z";
const evidence = [
  {
    url: "https://github.com/octo/demo",
    label: "octo/demo repository",
    collectedAt,
  },
];

const readiness: RepositoryReadiness = {
  repository: {
    coordinates: { owner: "octo", repo: "demo" },
    fullName: "octo/demo",
    name: "demo",
    description: null,
    defaultBranch: "main",
    visibility: "public",
    archived: false,
    fork: false,
    language: "TypeScript",
    license: null,
    topics: ["mcp"],
    stars: 0,
    forks: 0,
    openIssues: 0,
    createdAt: collectedAt,
    updatedAt: collectedAt,
    pushedAt: collectedAt,
    securitySettings: {
      advancedSecurity: null,
      secretScanning: "enabled",
      pushProtection: "disabled",
    },
    evidence,
  },
  branchRisk: {
    branch: "main",
    protected: true,
    protectionStatus: "protected",
    requiresPullRequestReviews: true,
    requiredApprovingReviews: 1,
    requiredStatusChecks: 2,
    enforceAdmins: true,
    allowsForcePushes: false,
    allowsDeletions: false,
    status: "available",
    reason: null,
    evidence,
  },
  deliveryHygiene: {
    recentCommits: 2,
    latestCommitAt: collectedAt,
    openPullRequests: 0,
    draftPullRequests: 0,
    workflowRuns: 3,
    successfulWorkflowRuns: 3,
    failedWorkflowRuns: 0,
    inProgressWorkflowRuns: 0,
    ciStatus: "healthy",
    status: "available",
    reason: null,
    evidence,
  },
  securityPosture: {
    codeScanning: {
      status: "available",
      value: { openAlerts: 0, highSeverityAlerts: 0 },
      reason: null,
      evidence,
      metadata: null,
    },
    dependabot: {
      status: "unknown",
      value: null,
      reason: "permission limited",
      evidence,
      metadata: null,
    },
    secretScanning: {
      status: "available",
      value: { openAlerts: 0 },
      reason: null,
      evidence,
      metadata: null,
    },
    overallStatus: "unknown",
    evidence,
  },
  actionPlan: [],
  status: "unknown",
  evidence,
};

describe("provider fact evaluation", () => {
  it("turns observed facts into stable checks without treating unknown as pass", () => {
    const checks = evaluateRepositoryReadiness(readiness);
    const byId = new Map(checks.map((check) => [check.ruleId, check]));

    expect(byId.get("public.description")?.state).toBe("fail");
    expect(byId.get("public.readme")?.state).toBe("unknown");
    expect(byId.get("security.secret-scanning")?.state).toBe("pass");
    expect(byId.get("security.push-protection")?.state).toBe("fail");
    expect(byId.get("security.dependabot")?.state).toBe("unknown");
    expect(scoreChecks(checks).confidence).not.toBe("high");
  });

  it("does not claim CI is present when no workflow runs were observed", () => {
    const checks = evaluateDeliveryHygiene({
      ...readiness.deliveryHygiene,
      workflowRuns: 0,
      ciStatus: "healthy",
    });

    expect(
      checks.find((check) => check.ruleId === "delivery.ci-present")?.state,
    ).toBe("fail");
  });
});
