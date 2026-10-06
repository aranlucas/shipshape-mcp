import { describe, expect, it } from "vitest";
import {
  REPOSITORY_SETTINGS,
  evaluateRepositoryDrift,
  type BranchProtectionFact,
  type ProtectionState,
  type RepositorySettingId,
  type RepositoryFileSettingId,
  type RepositoryRuleSettingId,
  type WorkflowSecuritySettingId,
  type RepositorySettingsFacts,
} from "../../src/drift/evaluate";
import { DriftPolicySchema } from "../../src/drift/policy";

// SAFETY: fromEntries receives exactly one entry per REPOSITORY_SETTINGS id.
const unknownSettings = Object.fromEntries(
  REPOSITORY_SETTINGS.map((definition) => [definition.id, null]),
) as Record<RepositorySettingId, boolean | null>;

const unknownRepositoryFiles: Record<RepositoryFileSettingId, boolean | null> =
  {
    "repositoryFiles.readme": null,
    "repositoryFiles.license": null,
    "repositoryFiles.contributing": null,
    "repositoryFiles.codeOfConduct": null,
    "repositoryFiles.security": null,
    "repositoryFiles.citation": null,
  };

const unknownWorkflowSecurity: Record<
  WorkflowSecuritySettingId,
  boolean | null
> = {
  "workflowSecurity.leastPrivilegeToken": null,
  "workflowSecurity.pinnedActions": null,
  "workflowSecurity.dependencyReview": null,
};

const unknownRepositoryRules: Record<RepositoryRuleSettingId, boolean | null> =
  {
    "repositoryRules.activeRuleset": null,
  };

function facts(
  overrides: Partial<RepositorySettingsFacts> = {},
): RepositorySettingsFacts {
  return {
    owner: "octo",
    repo: "svc-api",
    fullName: "octo/svc-api",
    url: "https://github.com/octo/svc-api",
    defaultBranch: "main",
    fork: false,
    archived: false,
    settings: unknownSettings,
    repositoryFiles: unknownRepositoryFiles,
    workflowSecurity: unknownWorkflowSecurity,
    repositoryRules: unknownRepositoryRules,
    privateVulnerabilityReporting: null,
    topics: ["api", "legacy"],
    branches: new Map(),
    ...overrides,
  };
}

const protectedMain: ProtectionState = {
  requiredSignatures: false,
  enforceAdmins: false,
  requiredLinearHistory: true,
  allowForcePushes: false,
  allowDeletions: false,
  requiredConversationResolution: false,
  reviews: {
    dismissStaleReviews: false,
    requireCodeOwnerReviews: true,
    requiredApprovingReviews: 2,
    requireLastPushApproval: true,
  },
  statusChecks: {
    strict: true,
    checks: [{ context: "build", appId: 15368 }],
  },
  restricted: false,
};

const policy = (rules: unknown[]) =>
  DriftPolicySchema.parse({ version: 1, rules });

describe("settings drift evaluation", () => {
  it("ignores repositories no rule selects", () => {
    expect(
      evaluateRepositoryDrift(
        policy([
          {
            id: "web",
            repositories: { include: ["web-*"] },
            features: { wiki: false },
          },
        ]),
        facts(),
      ),
    ).toBeNull();
  });

  it("reports pass, fail, and permission-gated unknown states with one PATCH", () => {
    const drift = evaluateRepositoryDrift(
      policy([
        {
          id: "squash-only",
          merge: { allowSquash: true, deleteBranchOnMerge: true },
          features: { wiki: false, issues: true },
          security: { pushProtection: true },
        },
      ]),
      facts({
        settings: {
          ...unknownSettings,
          "features.wiki": true,
          "features.issues": true,
          "merge.deleteBranchOnMerge": false,
        },
      }),
    );

    expect(drift?.status).toBe("drifted");
    expect(drift?.counts).toEqual({ pass: 1, fail: 2, unknown: 2 });
    expect(drift?.checks).toContainEqual(
      expect.objectContaining({
        setting: "merge.allowSquash",
        state: "unknown",
        actual: null,
      }),
    );
    expect(drift?.remediation).toEqual([
      expect.objectContaining({
        method: "PATCH",
        path: "/repos/octo/svc-api",
        body: {
          allow_squash_merge: true,
          delete_branch_on_merge: true,
          has_wiki: false,
          security_and_analysis: {
            secret_scanning_push_protection: { status: "enabled" },
          },
        },
      }),
    ]);
    expect(drift?.remediation[0]?.command).toBe(
      `gh api --method PATCH 'repos/octo/svc-api' --input - <<'JSON'\n${JSON.stringify(drift?.remediation[0]?.body)}\nJSON`,
    );
  });

  it("computes a complete topics replacement", () => {
    const drift = evaluateRepositoryDrift(
      policy([
        {
          id: "topics",
          topics: { required: ["typescript", "api"], forbidden: ["legacy"] },
        },
      ]),
      facts(),
    );

    expect(drift?.remediation).toEqual([
      expect.objectContaining({
        method: "PUT",
        path: "/repos/octo/svc-api/topics",
        body: { names: ["api", "typescript"] },
      }),
    ]);
  });

  it("overlays policy on current protection without weakening stricter settings", () => {
    const drift = evaluateRepositoryDrift(
      policy([
        {
          id: "protect",
          branchProtection: {
            requiredApprovingReviews: 1,
            enforceAdmins: true,
            requiredStatusChecks: ["build", "test"],
            requiredSignatures: true,
          },
        },
      ]),
      facts({
        branches: new Map<string, BranchProtectionFact>([
          ["main", { status: "protected", protection: protectedMain }],
        ]),
      }),
    );

    expect(
      drift?.checks.find(
        (check) => check.setting === "requiredApprovingReviews",
      ),
    ).toMatchObject({ state: "pass", actual: 2, expected: 1 });
    expect(drift?.remediation.map((step) => step.method)).toEqual([
      "PUT",
      "POST",
    ]);
    expect(drift?.remediation[0]).toMatchObject({
      path: "/repos/octo/svc-api/branches/main/protection",
      settings: ["enforceAdmins", "requiredStatusChecks"],
      body: {
        required_status_checks: {
          strict: true,
          checks: [{ context: "build", app_id: 15368 }, { context: "test" }],
        },
        enforce_admins: true,
        required_pull_request_reviews: {
          dismiss_stale_reviews: false,
          require_code_owner_reviews: true,
          required_approving_review_count: 2,
          require_last_push_approval: true,
        },
        restrictions: null,
        required_linear_history: true,
        allow_force_pushes: false,
        allow_deletions: false,
        required_conversation_resolution: false,
      },
    });
    expect(drift?.remediation[1]).toMatchObject({
      path: "/repos/octo/svc-api/branches/main/protection/required_signatures",
      body: null,
      command:
        "gh api --method POST 'repos/octo/svc-api/branches/main/protection/required_signatures'",
    });
  });

  it("protects an unprotected branch before requiring signatures", () => {
    const drift = evaluateRepositoryDrift(
      policy([
        {
          id: "signed",
          branchProtection: {
            requiredSignatures: true,
            allowForcePushes: false,
          },
        },
      ]),
      facts({
        branches: new Map([["main", { status: "unprotected" as const }]]),
      }),
    );

    expect(drift?.checks.map((check) => check.state)).toEqual(["fail", "fail"]);
    expect(
      drift?.remediation.map((step) => `${step.method} ${step.path}`),
    ).toEqual([
      "PUT /repos/octo/svc-api/branches/main/protection",
      "POST /repos/octo/svc-api/branches/main/protection/required_signatures",
    ]);
    expect(drift?.remediation[0]?.body).toMatchObject({
      allow_force_pushes: false,
      allow_deletions: true,
    });
  });

  it("leaves invisible or restricted protection to a manual review", () => {
    const rules = policy([
      { id: "admins", branchProtection: { enforceAdmins: true } },
    ]);

    const hidden = evaluateRepositoryDrift(
      rules,
      facts({
        branches: new Map([
          ["main", { status: "unknown" as const, reason: "HTTP 403" }],
        ]),
      }),
    );

    expect(hidden?.status).toBe("unknown");
    expect(hidden?.remediation).toEqual([]);
    expect(hidden?.manual).toEqual([
      expect.objectContaining({ setting: "enforceAdmins", branch: "main" }),
    ]);

    const restricted = evaluateRepositoryDrift(
      rules,
      facts({
        branches: new Map([
          [
            "main",
            {
              status: "protected" as const,
              protection: { ...protectedMain, restricted: true },
            },
          ],
        ]),
      }),
    );

    expect(restricted?.status).toBe("drifted");
    expect(restricted?.remediation).toEqual([]);
    expect(restricted?.manual[0]?.reason).toContain("restricts who can push");
  });

  it("reports contradictory rules as conflicts and never remediates them", () => {
    const drift = evaluateRepositoryDrift(
      policy([
        { id: "squash", merge: { allowSquash: true, allowRebase: false } },
        {
          id: "rebase",
          repositories: { include: ["svc-*"] },
          merge: { allowSquash: false },
        },
      ]),
      facts({
        settings: {
          ...unknownSettings,
          "merge.allowSquash": true,
          "merge.allowRebase": true,
        },
      }),
    );

    expect(drift?.rules).toEqual(["squash", "rebase"]);
    expect(drift?.conflicts).toEqual([
      expect.objectContaining({
        setting: "merge.allowSquash",
        reason: expect.stringContaining("squash, rebase"),
      }),
    ]);
    expect(drift?.remediation[0]?.body).toEqual({ allow_rebase_merge: false });
  });

  it("shell-quotes branch names in generated commands", () => {
    const drift = evaluateRepositoryDrift(
      policy([
        {
          id: "rel",
          branchProtection: { branch: "it's", requiredSignatures: false },
        },
      ]),
      facts({
        branches: new Map([
          [
            "it's",
            {
              status: "protected" as const,
              protection: { ...protectedMain, requiredSignatures: true },
            },
          ],
        ]),
      }),
    );

    expect(drift?.remediation[0]?.command).toBe(
      "gh api --method DELETE 'repos/octo/svc-api/branches/it'\\''s/protection/required_signatures'",
    );
  });
});
