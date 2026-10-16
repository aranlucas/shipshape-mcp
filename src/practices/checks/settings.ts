import { z } from "zod";
import { ConfigObjectSchema, locateConfigValue } from "../config-value";
import type { BranchProtectionFact, ProtectionState } from "../protection";
import type { Check } from "../schema";
import type { RepoSnapshot } from "../snapshot";
import type { CheckOutcome } from "./result";

type SettingCheck = Extract<Check, { type: "setting" }>;

type BranchProtectionCheck = Extract<Check, { type: "branch-protection" }>;

type BooleanProtectionCheck = Extract<BranchProtectionCheck, { equals: boolean }>;

type KnownProtectionFact = Exclude<BranchProtectionFact, { status: "unknown" }>;

export function inspectSetting(check: SettingCheck, snapshot: RepoSnapshot): CheckOutcome {
  const error = z.object({ error: z.string() }).safeParse(snapshot.settings).data?.error;
  const settings = ConfigObjectSchema.safeParse(snapshot.settings);

  if (error !== undefined || !settings.success) {
    return {
      state: "unknown",
      expected: check.equals,
      detail: error ?? "Repository settings were not collected.",
    };
  }

  const located = locateConfigValue(settings.data, check.key);

  if (!located.present) {
    return {
      state: "unknown",
      expected: check.equals,
      detail: "GitHub did not disclose this setting.",
    };
  }

  return {
    state: located.value === check.equals ? "pass" : "fail",
    expected: check.equals,
    actual: located.value,
  };
}

function booleanProtectionValue(
  state: ProtectionState,
  key: BooleanProtectionCheck["key"],
): boolean | null {
  switch (key) {
    case "dismissStaleReviews":
      return state.reviews?.dismissStaleReviews ?? false;
    case "requireCodeOwnerReviews":
      return state.reviews?.requireCodeOwnerReviews ?? false;
    case "requireLastPushApproval":
      return state.reviews?.requireLastPushApproval ?? false;
    case "requiredSignatures":
      return state.requiredSignatures;
    case "enforceAdmins":
      return state.enforceAdmins;
    case "requiredLinearHistory":
      return state.requiredLinearHistory;
    case "allowForcePushes":
      return state.allowForcePushes;
    case "allowDeletions":
      return state.allowDeletions;
    case "requiredConversationResolution":
      return state.requiredConversationResolution;
  }
}

function protectionState(fact: KnownProtectionFact): ProtectionState {
  if (fact.status === "protected") {
    return fact.protection;
  }

  return {
    requiredSignatures: false,
    enforceAdmins: false,
    requiredLinearHistory: false,
    allowForcePushes: true,
    allowDeletions: true,
    requiredConversationResolution: false,
    reviews: null,
    statusChecks: null,
    restricted: false,
  };
}

export function inspectBranchProtection(
  check: BranchProtectionCheck,
  snapshot: RepoSnapshot,
): CheckOutcome {
  const branch = check.branch ?? snapshot.repo.defaultBranch;
  const fact = snapshot.protection.get(branch);
  const evidence = { path: branch, expected: check.equals };

  if (!fact || fact.status === "unknown") {
    return {
      ...evidence,
      state: "unknown",
      detail: fact?.reason ?? "Branch protection was not collected.",
    };
  }

  const protection = protectionState(fact);

  switch (check.key) {
    case "requiredApprovingReviews": {
      const actual = protection.reviews?.requiredApprovingReviews ?? 0;

      return { ...evidence, state: actual === check.equals ? "pass" : "fail", actual };
    }

    case "requiredStatusChecks": {
      const actual = protection.statusChecks?.checks.map((item) => item.context) ?? [];
      const expectedContexts = new Set(check.equals);
      const actualContexts = new Set(actual);

      const passes =
        actualContexts.size === expectedContexts.size &&
        actual.every((context) => expectedContexts.has(context));

      return { ...evidence, state: passes ? "pass" : "fail", actual };
    }

    case "allowDeletions":
    case "allowForcePushes":
    case "dismissStaleReviews":
    case "enforceAdmins":
    case "requireCodeOwnerReviews":
    case "requireLastPushApproval":
    case "requiredConversationResolution":
    case "requiredLinearHistory":
    case "requiredSignatures": {
      const actual = booleanProtectionValue(protection, check.key);

      return actual === null
        ? {
            ...evidence,
            state: "unknown",
            detail: "GitHub did not report this protection setting.",
          }
        : { ...evidence, state: actual === check.equals ? "pass" : "fail", actual };
    }
  }
}
