import type { GitHubBranchProtection } from "../github/schemas";

export interface StatusCheckFact {
  readonly context: string;
  readonly appId: number | null;
}

/** Branch protection as GitHub reports it; booleans are null when absent. */
export interface ProtectionState {
  readonly requiredSignatures: boolean | null;
  readonly enforceAdmins: boolean;
  readonly requiredLinearHistory: boolean;
  readonly allowForcePushes: boolean;
  readonly allowDeletions: boolean;
  readonly requiredConversationResolution: boolean;
  readonly reviews: {
    readonly dismissStaleReviews: boolean;
    readonly requireCodeOwnerReviews: boolean;
    readonly requiredApprovingReviews: number;
    readonly requireLastPushApproval: boolean;
  } | null;
  readonly statusChecks: {
    readonly strict: boolean;
    readonly checks: readonly StatusCheckFact[];
  } | null;
  /** Push restrictions name users and teams that a replacement cannot rebuild. */
  readonly restricted: boolean;
}

export type BranchProtectionFact =
  | { readonly status: "unknown"; readonly reason: string }
  | { readonly status: "unprotected" }
  | { readonly status: "protected"; readonly protection: ProtectionState };

export function protectionState(protection: GitHubBranchProtection): ProtectionState {
  const reviews = protection.required_pull_request_reviews;
  const checks = protection.required_status_checks;

  return {
    requiredSignatures: protection.required_signatures ?? null,
    enforceAdmins: protection.enforce_admins?.enabled ?? false,
    requiredLinearHistory: protection.required_linear_history ?? false,
    allowForcePushes: protection.allow_force_pushes ?? false,
    allowDeletions: protection.allow_deletions ?? false,
    requiredConversationResolution: protection.required_conversation_resolution ?? false,
    reviews: reviews
      ? {
          dismissStaleReviews: reviews.dismiss_stale_reviews ?? false,
          requireCodeOwnerReviews: reviews.require_code_owner_reviews ?? false,
          requiredApprovingReviews: reviews.required_approving_review_count ?? 0,
          requireLastPushApproval: reviews.require_last_push_approval ?? false,
        }
      : null,
    statusChecks: checks
      ? {
          strict: checks.strict ?? false,
          checks: checks.checks?.length
            ? checks.checks.flatMap((check) =>
                check.context ? [{ context: check.context, appId: check.app_id ?? null }] : [],
              )
            : (checks.contexts ?? []).map((context) => ({ context, appId: null })),
        }
      : null,
    restricted: protection.restrictions !== null && protection.restrictions !== undefined,
  };
}
