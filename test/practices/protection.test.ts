import { describe, expect, it } from "vitest";
import { GitHubBranchProtectionSchema } from "@/github/schemas";
import { protectionState } from "@/practices/protection";

describe("branch protection response mapping", () => {
  it("normalizes GitHub's enabled response shape and preserves protection details", () => {
    const protection = GitHubBranchProtectionSchema.parse({
      required_status_checks: {
        strict: true,
        contexts: ["legacy-context"],
        checks: [
          { context: "build", app_id: 15368 },
          { context: "test", app_id: null },
        ],
      },
      enforce_admins: { enabled: true },
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        require_code_owner_reviews: true,
        required_approving_review_count: 2,
        require_last_push_approval: true,
      },
      restrictions: { users: [{ login: "octo" }], teams: [], apps: [] },
      required_signatures: { enabled: true },
      required_linear_history: { enabled: true },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: true },
      required_conversation_resolution: { enabled: false },
    });

    expect(protectionState(protection)).toEqual({
      requiredSignatures: true,
      enforceAdmins: true,
      requiredLinearHistory: true,
      allowForcePushes: false,
      allowDeletions: true,
      requiredConversationResolution: false,
      reviews: {
        dismissStaleReviews: true,
        requireCodeOwnerReviews: true,
        requiredApprovingReviews: 2,
        requireLastPushApproval: true,
      },
      statusChecks: {
        strict: true,
        checks: [
          { context: "build", appId: 15368 },
          { context: "test", appId: null },
        ],
      },
      restricted: true,
    });
  });

  it("falls back to contexts when GitHub omits structured status checks", () => {
    const protection = GitHubBranchProtectionSchema.parse({
      required_status_checks: { strict: false, contexts: ["verify", "deploy"], checks: [] },
      restrictions: null,
    });

    expect(protectionState(protection).statusChecks).toEqual({
      strict: false,
      checks: [
        { context: "verify", appId: null },
        { context: "deploy", appId: null },
      ],
    });
    expect(protectionState(protection).restricted).toBe(false);
  });
});
