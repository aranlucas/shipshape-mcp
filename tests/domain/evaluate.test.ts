import { describe, expect, it } from "vitest";

import {
  evaluateDeliveryHygiene,
  evaluateSecurityPosture,
  evaluateRepositoryReadiness,
  repositoryReadinessStatus,
  type RepositoryAuditInput,
} from "../../src/domain/evaluate";
import { scoreChecks } from "../../src/domain/scoring";

const collectedAt = "2026-08-30T20:00:00.000Z";
const evidence = [
  {
    url: "https://github.com/octo/demo",
    label: "octo/demo repository",
    collectedAt,
  },
];

const readiness: RepositoryAuditInput = {
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
    pullRequestSettings: {
      allowMergeCommit: true,
      allowRebaseMerge: false,
      allowUpdateBranch: true,
    },
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
    cancelledWorkflowRuns: 0,
    inProgressWorkflowRuns: 0,
    latestWorkflowRun: null,
    failingWorkflowRuns: [],
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
    expect(byId.get("delivery.merge-commits-disabled")?.state).toBe("fail");
    expect(byId.get("delivery.rebase-merging-disabled")?.state).toBe("pass");
    expect(byId.get("delivery.update-branches-suggested")?.state).toBe("pass");
    expect(scoreChecks(checks).confidence).not.toBe("high");
  });

  it("keeps unavailable pull request settings unknown", () => {
    const checks = evaluateRepositoryReadiness({
      ...readiness,
      repository: {
        ...readiness.repository,
        pullRequestSettings: {
          allowMergeCommit: null,
          allowRebaseMerge: null,
          allowUpdateBranch: null,
        },
      },
    });

    expect(
      checks
        .filter((check) => check.ruleId.startsWith("delivery."))
        .filter(
          (check) =>
            check.ruleId.includes("merg") ||
            check.ruleId.includes("update-branches"),
        )
        .map((check) => check.state),
    ).toEqual(["unknown", "unknown", "unknown"]);
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

  it("ignores open security alerts when the code-scanning endpoint is available", () => {
    const checks = evaluateSecurityPosture(
      {
        ...readiness.securityPosture,
        codeScanning: {
          status: "available",
          value: { openAlerts: 3, highSeverityAlerts: 2 },
          reason: null,
          evidence,
          metadata: null,
        },
        dependabot: {
          status: "available",
          value: { openAlerts: 1, criticalAlerts: 1 },
          reason: null,
          evidence,
          metadata: null,
        },
        overallStatus: "needs-attention",
      },
      readiness.repository,
      readiness.branchRisk,
    );

    expect(
      checks.find((check) => check.ruleId === "security.code-scanning")?.state,
    ).toBe("pass");
  });

  it("derives product status from domain failures, not collector heuristics", () => {
    expect(repositoryReadinessStatus(readiness)).toBe("needs-attention");

    const passing = {
      ...readiness,
      repository: {
        ...readiness.repository,
        description: "Public demo repository",
        license: "MIT",
        topics: ["mcp", "github", "maintenance"],
        pullRequestSettings: {
          allowMergeCommit: false,
          allowRebaseMerge: false,
          allowUpdateBranch: true,
        },
        securitySettings: {
          ...readiness.repository.securitySettings,
          pushProtection: "enabled",
        },
      },
      securityPosture: {
        ...readiness.securityPosture,
        codeScanning: {
          status: "available" as const,
          value: { openAlerts: 4, highSeverityAlerts: 2 },
          reason: null,
          evidence,
          metadata: null,
        },
        dependabot: {
          status: "available" as const,
          value: { openAlerts: 1, criticalAlerts: 1 },
          reason: null,
          evidence,
          metadata: null,
        },
        overallStatus: "needs-attention" as const,
      },
    };

    expect(repositoryReadinessStatus(passing)).toBe("ready");
  });

  it("keeps status unknown when collection is incomplete and nothing failed", () => {
    const incomplete = {
      ...readiness,
      repository: {
        ...readiness.repository,
        description: "Public demo repository",
        license: "MIT",
        topics: ["mcp", "github", "maintenance"],
        pullRequestSettings: {
          allowMergeCommit: false,
          allowRebaseMerge: false,
          allowUpdateBranch: true,
        },
        securitySettings: {
          ...readiness.repository.securitySettings,
          pushProtection: "enabled",
        },
      },
      branchRisk: {
        ...readiness.branchRisk,
        status: "partial" as const,
        reason: "GitHub feature unavailable or permission-limited (HTTP 404)",
      },
    };

    expect(
      evaluateRepositoryReadiness(incomplete).some(
        (check) => check.state === "fail",
      ),
    ).toBe(false);
    expect(repositoryReadinessStatus(incomplete)).toBe("unknown");
  });

  it("does not require pull-request approvals for branch security controls", () => {
    const checks = evaluateSecurityPosture(
      readiness.securityPosture,
      readiness.repository,
      {
        ...readiness.branchRisk,
        requiresPullRequestReviews: false,
        requiredApprovingReviews: 0,
      },
    );

    expect(
      checks.find((check) => check.ruleId === "security.branch-protection"),
    ).toMatchObject({
      state: "pass",
    });
  });
});
