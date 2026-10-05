import { ruleSelects, type DriftPolicy, type DriftRule } from "./policy";

/**
 * Repository-level settings that one `PATCH /repos/{owner}/{repo}` can set.
 * Identifiers are API: they appear in tool output and in policy files.
 */
export const REPOSITORY_SETTINGS = [
  {
    id: "merge.allowSquash",
    section: "merge",
    key: "allowSquash",
    field: "allow_squash_merge",
    security: false,
  },
  {
    id: "merge.allowMergeCommit",
    section: "merge",
    key: "allowMergeCommit",
    field: "allow_merge_commit",
    security: false,
  },
  {
    id: "merge.allowRebase",
    section: "merge",
    key: "allowRebase",
    field: "allow_rebase_merge",
    security: false,
  },
  {
    id: "merge.allowAutoMerge",
    section: "merge",
    key: "allowAutoMerge",
    field: "allow_auto_merge",
    security: false,
  },
  {
    id: "merge.allowUpdateBranch",
    section: "merge",
    key: "allowUpdateBranch",
    field: "allow_update_branch",
    security: false,
  },
  {
    id: "merge.deleteBranchOnMerge",
    section: "merge",
    key: "deleteBranchOnMerge",
    field: "delete_branch_on_merge",
    security: false,
  },
  {
    id: "features.issues",
    section: "features",
    key: "issues",
    field: "has_issues",
    security: false,
  },
  {
    id: "features.wiki",
    section: "features",
    key: "wiki",
    field: "has_wiki",
    security: false,
  },
  {
    id: "features.projects",
    section: "features",
    key: "projects",
    field: "has_projects",
    security: false,
  },
  {
    id: "features.discussions",
    section: "features",
    key: "discussions",
    field: "has_discussions",
    security: false,
  },
  {
    id: "security.secretScanning",
    section: "security",
    key: "secretScanning",
    field: "secret_scanning",
    security: true,
  },
  {
    id: "security.pushProtection",
    section: "security",
    key: "pushProtection",
    field: "secret_scanning_push_protection",
    security: true,
  },
  {
    id: "security.dependabotSecurityUpdates",
    section: "security",
    key: "dependabotSecurityUpdates",
    field: "dependabot_security_updates",
    security: true,
  },
] as const;

export type RepositorySettingId = (typeof REPOSITORY_SETTINGS)[number]["id"];

const PROTECTION_FLAGS = [
  "requiredSignatures",
  "enforceAdmins",
  "requiredLinearHistory",
  "allowForcePushes",
  "allowDeletions",
  "requiredConversationResolution",
  "dismissStaleReviews",
  "requireCodeOwnerReviews",
] as const;

type ProtectionFlag = (typeof PROTECTION_FLAGS)[number];

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

export interface RepositorySettingsFacts {
  readonly owner: string;
  readonly repo: string;
  readonly fullName: string;
  readonly url: string;
  readonly defaultBranch: string;
  readonly fork: boolean;
  readonly archived: boolean;
  /** Null means GitHub did not disclose the value to this credential. */
  readonly settings: Readonly<Record<RepositorySettingId, boolean | null>>;
  readonly topics: readonly string[];
  readonly branches: ReadonlyMap<string, BranchProtectionFact>;
}

type DriftValue = boolean | number | readonly string[];

export interface DriftCheck {
  readonly rule: string;
  readonly setting: string;
  readonly branch: string | null;
  readonly state: "pass" | "fail" | "unknown";
  readonly expected: DriftValue;
  readonly actual: DriftValue | null;
  readonly reason: string | null;
  readonly evidence: string;
}

export interface RemediationStep {
  readonly title: string;
  readonly method: "PATCH" | "PUT" | "POST" | "DELETE";
  readonly path: string;
  readonly body: RemediationBody | null;
  /** A `gh api` invocation a maintainer can review and run. Never executed. */
  readonly command: string;
  readonly settings: readonly string[];
}

export type RemediationBody =
  | string
  | number
  | boolean
  | null
  | readonly RemediationBody[]
  | { readonly [key: string]: RemediationBody };

export interface ManualStep {
  readonly setting: string;
  readonly branch: string | null;
  readonly reason: string;
  readonly evidence: string;
}

export interface RepositoryDrift {
  readonly repository: string;
  readonly url: string;
  readonly status: "compliant" | "drifted" | "unknown";
  readonly rules: readonly string[];
  readonly counts: { pass: number; fail: number; unknown: number };
  readonly checks: readonly DriftCheck[];
  readonly conflicts: readonly ManualStep[];
  readonly remediation: readonly RemediationStep[];
  readonly manual: readonly ManualStep[];
}

type Expectation =
  | {
      readonly kind: "repository";
      readonly rule: string;
      readonly setting: RepositorySettingId;
      readonly value: boolean;
    }
  | {
      readonly kind: "topics";
      readonly rule: string;
      readonly setting: "topics.required" | "topics.forbidden";
      readonly value: readonly string[];
    }
  | {
      readonly kind: "flag";
      readonly rule: string;
      readonly setting: ProtectionFlag;
      readonly branch: string;
      readonly value: boolean;
    }
  | {
      readonly kind: "approvals";
      readonly rule: string;
      readonly setting: "requiredApprovingReviews";
      readonly branch: string;
      readonly value: number;
    }
  | {
      readonly kind: "checks";
      readonly rule: string;
      readonly setting: "requiredStatusChecks";
      readonly branch: string;
      readonly value: readonly string[];
    };

/** The branches a policy needs protection evidence for, per repository. */
export function protectedBranchesFor(
  policy: DriftPolicy,
  repository: { name: string; fork: boolean; archived: boolean },
  defaultBranch: string,
): string[] {
  const branches = new Set<string>();

  for (const rule of policy.rules)
    if (rule.branchProtection && ruleSelects(rule, repository))
      branches.add(rule.branchProtection.branch ?? defaultBranch);

  return [...branches].sort();
}

function expectations(rule: DriftRule, defaultBranch: string): Expectation[] {
  const result: Expectation[] = [];

  const sections = {
    merge: rule.merge,
    features: rule.features,
    security: rule.security,
  };

  for (const definition of REPOSITORY_SETTINGS) {
    const value = Object.entries(sections[definition.section] ?? {}).find(
      ([name]) => name === definition.key,
    )?.[1];

    if (value !== undefined)
      result.push({
        kind: "repository",
        rule: rule.id,
        setting: definition.id,
        value,
      });
  }

  if (rule.topics?.required.length)
    result.push({
      kind: "topics",
      rule: rule.id,
      setting: "topics.required",
      value: rule.topics.required,
    });

  if (rule.topics?.forbidden.length)
    result.push({
      kind: "topics",
      rule: rule.id,
      setting: "topics.forbidden",
      value: rule.topics.forbidden,
    });

  const protection = rule.branchProtection;

  if (!protection) return result;
  const branch = protection.branch ?? defaultBranch;

  for (const setting of PROTECTION_FLAGS) {
    const value = protection[setting];

    if (value !== undefined)
      result.push({ kind: "flag", rule: rule.id, setting, branch, value });
  }

  if (protection.requiredApprovingReviews !== undefined)
    result.push({
      kind: "approvals",
      rule: rule.id,
      setting: "requiredApprovingReviews",
      branch,
      value: protection.requiredApprovingReviews,
    });

  if (protection.requiredStatusChecks?.length)
    result.push({
      kind: "checks",
      rule: rule.id,
      setting: "requiredStatusChecks",
      branch,
      value: protection.requiredStatusChecks,
    });

  return result;
}

const UNPROTECTED: ProtectionState = {
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

function protectionState(fact: BranchProtectionFact | undefined) {
  if (!fact) return null;

  if (fact.status === "unprotected") return UNPROTECTED;

  return fact.status === "protected" ? fact.protection : null;
}

function flagValue(state: ProtectionState, flag: ProtectionFlag) {
  if (flag === "dismissStaleReviews")
    return state.reviews?.dismissStaleReviews ?? false;

  if (flag === "requireCodeOwnerReviews")
    return state.reviews?.requireCodeOwnerReviews ?? false;

  return state[flag];
}

function compare(
  facts: RepositorySettingsFacts,
  expectation: Expectation,
): Pick<DriftCheck, "state" | "actual" | "reason"> {
  const unknown = (reason: string) => ({
    state: "unknown" as const,
    actual: null,
    reason,
  });

  const verdict = (passed: boolean, actual: DriftValue) => ({
    state: passed ? ("pass" as const) : ("fail" as const),
    actual,
    reason: null,
  });

  if (expectation.kind === "repository") {
    const actual = facts.settings[expectation.setting];

    if (actual === null)
      return unknown(
        "GitHub only discloses this setting to repository administrators.",
      );

    return verdict(actual === expectation.value, actual);
  }

  if (expectation.kind === "topics") {
    const present = new Set(facts.topics);

    const offending = expectation.value.filter((topic) =>
      expectation.setting === "topics.required"
        ? !present.has(topic)
        : present.has(topic),
    );

    return verdict(offending.length === 0, facts.topics);
  }

  const fact = facts.branches.get(expectation.branch);
  const state = protectionState(fact);

  if (!state)
    return unknown(
      fact?.status === "unknown"
        ? fact.reason
        : "Branch protection was not collected.",
    );

  if (expectation.kind === "flag") {
    const actual = flagValue(state, expectation.setting);

    if (actual === null)
      return unknown("GitHub did not report this protection setting.");

    return verdict(actual === expectation.value, actual);
  }

  if (expectation.kind === "approvals") {
    const actual = state.reviews?.requiredApprovingReviews ?? 0;

    return verdict(actual >= expectation.value, actual);
  }

  const contexts = (state.statusChecks?.checks ?? []).map(
    (check) => check.context,
  );

  return verdict(
    expectation.value.every((context) => contexts.includes(context)),
    contexts,
  );
}

function evidenceUrl(facts: RepositorySettingsFacts, expectation: Expectation) {
  if (expectation.kind === "topics") return facts.url;

  if (expectation.kind !== "repository")
    return `${facts.url}/settings/branches`;

  return expectation.setting.startsWith("security.")
    ? `${facts.url}/settings/security_analysis`
    : `${facts.url}/settings`;
}

function branchOf(expectation: Expectation): string | null {
  return expectation.kind === "repository" || expectation.kind === "topics"
    ? null
    : expectation.branch;
}

/** Single-quote a word for POSIX shells. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function step(
  title: string,
  method: RemediationStep["method"],
  path: string,
  body: RemediationBody | null,
  settings: readonly string[],
): RemediationStep {
  const base = `gh api --method ${method} ${shellQuote(path.slice(1))}`;

  return {
    title,
    method,
    path,
    body,
    command:
      body === null
        ? base
        : `${base} --input - <<'JSON'\n${JSON.stringify(body)}\nJSON`,
    settings,
  };
}

interface Desired {
  readonly repository: Map<RepositorySettingId, boolean>;
  readonly required: Set<string>;
  readonly forbidden: Set<string>;
  readonly branches: Map<
    string,
    {
      flags: Map<ProtectionFlag, boolean>;
      conflicted: Set<ProtectionFlag>;
      approvals: number | null;
      checks: Set<string>;
    }
  >;
}

/**
 * Combine every matching rule's expectations.  Contradictory boolean values or
 * a topic both required and forbidden become conflicts and are never fixed.
 */
function desiredState(all: readonly Expectation[]) {
  const desired: Desired = {
    repository: new Map(),
    required: new Set(),
    forbidden: new Set(),
    branches: new Map(),
  };

  const conflicts = new Set<string>();

  const branch = (name: string) => {
    let value = desired.branches.get(name);

    if (!value) {
      value = {
        flags: new Map(),
        conflicted: new Set(),
        approvals: null,
        checks: new Set(),
      };
      desired.branches.set(name, value);
    }

    return value;
  };

  for (const expectation of all) {
    if (expectation.kind === "repository") {
      const previous = desired.repository.get(expectation.setting);

      if (previous !== undefined && previous !== expectation.value)
        conflicts.add(expectation.setting);
      desired.repository.set(expectation.setting, expectation.value);
    } else if (expectation.kind === "topics") {
      const target =
        expectation.setting === "topics.required"
          ? desired.required
          : desired.forbidden;

      for (const topic of expectation.value) target.add(topic);
    } else if (expectation.kind === "flag") {
      const target = branch(expectation.branch);
      const previous = target.flags.get(expectation.setting);

      if (previous !== undefined && previous !== expectation.value) {
        conflicts.add(`${expectation.branch}:${expectation.setting}`);
        target.conflicted.add(expectation.setting);
      }

      target.flags.set(expectation.setting, expectation.value);
    } else if (expectation.kind === "approvals") {
      const target = branch(expectation.branch);
      target.approvals = Math.max(target.approvals ?? 0, expectation.value);
    } else {
      const target = branch(expectation.branch);

      for (const context of expectation.value) target.checks.add(context);
    }
  }

  for (const topic of desired.required)
    if (desired.forbidden.has(topic)) conflicts.add("topics");

  return { desired, conflicts };
}

function conflictKey(expectation: Expectation): string {
  if (expectation.kind === "repository") return expectation.setting;

  if (expectation.kind === "topics") return "topics";

  return `${expectation.branch}:${expectation.setting}`;
}

/** A complete `PUT .../protection` body: current settings with policy overlaid. */
function protectionBody(
  current: ProtectionState,
  wanted: NonNullable<ReturnType<Desired["branches"]["get"]>>,
): RemediationBody {
  const flag = (name: ProtectionFlag, actual: boolean) =>
    wanted.conflicted.has(name) ? actual : (wanted.flags.get(name) ?? actual);

  const reviewsWanted =
    wanted.approvals !== null ||
    flag("dismissStaleReviews", false) ||
    flag("requireCodeOwnerReviews", false);

  const reviews =
    current.reviews || reviewsWanted
      ? {
          dismiss_stale_reviews: flag(
            "dismissStaleReviews",
            current.reviews?.dismissStaleReviews ?? false,
          ),
          require_code_owner_reviews: flag(
            "requireCodeOwnerReviews",
            current.reviews?.requireCodeOwnerReviews ?? false,
          ),
          required_approving_review_count: Math.max(
            current.reviews?.requiredApprovingReviews ?? 0,
            wanted.approvals ?? 0,
          ),
          require_last_push_approval:
            current.reviews?.requireLastPushApproval ?? false,
        }
      : null;

  const existing = current.statusChecks?.checks ?? [];

  const missing = [...wanted.checks].flatMap((context) =>
    existing.some((check) => check.context === context)
      ? []
      : [{ context, appId: null }],
  );

  const checks = [...existing, ...missing];

  return {
    required_status_checks:
      current.statusChecks || checks.length
        ? {
            strict: current.statusChecks?.strict ?? false,
            checks: checks.map((check): RemediationBody =>
              check.appId === null
                ? { context: check.context }
                : { context: check.context, app_id: check.appId },
            ),
          }
        : null,
    enforce_admins: flag("enforceAdmins", current.enforceAdmins),
    required_pull_request_reviews: reviews,
    restrictions: null,
    required_linear_history: flag(
      "requiredLinearHistory",
      current.requiredLinearHistory,
    ),
    allow_force_pushes: flag("allowForcePushes", current.allowForcePushes),
    allow_deletions: flag("allowDeletions", current.allowDeletions),
    required_conversation_resolution: flag(
      "requiredConversationResolution",
      current.requiredConversationResolution,
    ),
  };
}

export function evaluateRepositoryDrift(
  policy: DriftPolicy,
  facts: RepositorySettingsFacts,
): RepositoryDrift | null {
  const rules = policy.rules.filter((rule) =>
    ruleSelects(rule, {
      name: facts.repo,
      fork: facts.fork,
      archived: facts.archived,
    }),
  );

  if (!rules.length) return null;

  const all = rules.flatMap((rule) => expectations(rule, facts.defaultBranch));

  const checks: DriftCheck[] = all.map((expectation) => ({
    rule: expectation.rule,
    setting: expectation.setting,
    branch: branchOf(expectation),
    expected: expectation.value,
    evidence: evidenceUrl(facts, expectation),
    ...compare(facts, expectation),
  }));

  const { desired, conflicts } = desiredState(all);

  const conflictSteps: ManualStep[] = [];
  const reported = new Set<string>();

  for (const [index, expectation] of all.entries()) {
    const key = conflictKey(expectation);

    if (!conflicts.has(key) || reported.has(key)) continue;
    reported.add(key);
    conflictSteps.push({
      setting: expectation.kind === "topics" ? "topics" : expectation.setting,
      branch: branchOf(expectation),
      reason: `Matching rules disagree: ${all
        .filter((other) => conflictKey(other) === key)
        .map((other) => other.rule)
        .join(", ")}. Resolve the policy before remediating.`,
      evidence: checks[index]?.evidence ?? facts.url,
    });
  }

  // Unknown values are included: these writes are idempotent, so an
  // administrator can safely apply them without first seeing the setting.
  const open = (expectation: Expectation, index: number) =>
    checks[index]?.state !== "pass" && !conflicts.has(conflictKey(expectation));

  const remediation: RemediationStep[] = [];
  const manual: ManualStep[] = [];
  const repositoryPath = `/repos/${facts.owner}/${facts.repo}`;
  const patch: { [key: string]: RemediationBody } = {};
  const security: { [key: string]: RemediationBody } = {};
  const patched: string[] = [];

  for (const [index, expectation] of all.entries()) {
    if (expectation.kind !== "repository" || !open(expectation, index))
      continue;

    const definition = REPOSITORY_SETTINGS.find(
      (item) => item.id === expectation.setting,
    );

    if (!definition || patched.includes(definition.id)) continue;
    patched.push(definition.id);

    if (definition.security)
      security[definition.field] = {
        status: expectation.value ? "enabled" : "disabled",
      };
    else patch[definition.field] = expectation.value;
  }

  if (Object.keys(security).length) patch.security_and_analysis = security;

  if (patched.length)
    remediation.push(
      step(
        "Update repository settings",
        "PATCH",
        repositoryPath,
        patch,
        patched,
      ),
    );

  const topicsOpen = all.some(
    (expectation, index) =>
      expectation.kind === "topics" && open(expectation, index),
  );

  if (topicsOpen) {
    const names = [
      ...facts.topics.filter((topic) => !desired.forbidden.has(topic)),
      ...[...desired.required].filter((topic) => !facts.topics.includes(topic)),
    ];

    remediation.push(
      step(
        "Replace repository topics",
        "PUT",
        `${repositoryPath}/topics`,
        { names },
        ["topics"],
      ),
    );
  }

  for (const [branch, wanted] of desired.branches) {
    const branchChecks = all.flatMap((expectation, index) =>
      branchOf(expectation) === branch && open(expectation, index)
        ? [expectation]
        : [],
    );

    if (!branchChecks.length) continue;
    const protectionPath = `${repositoryPath}/branches/${encodeURIComponent(branch)}/protection`;
    const evidence = `${facts.url}/settings/branches`;
    const fact = facts.branches.get(branch);
    const current = protectionState(fact);

    const replaced = branchChecks.filter(
      (expectation) => expectation.setting !== "requiredSignatures",
    );

    const settings = [...new Set(replaced.map((item) => item.setting))];

    if (replaced.length && (!current || current.restricted)) {
      for (const setting of settings)
        manual.push({
          setting,
          branch,
          reason: current
            ? "The branch restricts who can push; edit protection in settings so the restriction list is preserved."
            : "Branch protection is not visible to this credential, so a safe replacement body cannot be built. An administrator should review it in settings.",
          evidence,
        });
    } else if (replaced.length && current) {
      remediation.push(
        step(
          `Update protection for ${branch}`,
          "PUT",
          protectionPath,
          protectionBody(current, wanted),
          settings,
        ),
      );
    }

    const signatures = branchChecks.find(
      (expectation) => expectation.setting === "requiredSignatures",
    );

    if (signatures?.kind !== "flag") continue;

    if (signatures.value && fact?.status === "unprotected" && !replaced.length)
      remediation.push(
        step(
          `Protect ${branch}`,
          "PUT",
          protectionPath,
          protectionBody(UNPROTECTED, {
            flags: new Map(),
            conflicted: new Set(),
            approvals: null,
            checks: new Set(),
          }),
          ["requiredSignatures"],
        ),
      );

    remediation.push(
      step(
        `${signatures.value ? "Require" : "Stop requiring"} signed commits on ${branch}`,
        signatures.value ? "POST" : "DELETE",
        `${protectionPath}/required_signatures`,
        null,
        ["requiredSignatures"],
      ),
    );
  }

  const counts = { pass: 0, fail: 0, unknown: 0 };

  for (const check of checks) counts[check.state] += 1;

  return {
    repository: facts.fullName,
    url: facts.url,
    status: counts.fail
      ? "drifted"
      : counts.unknown || conflictSteps.length
        ? "unknown"
        : "compliant",
    rules: rules.map((rule) => rule.id),
    counts,
    checks,
    conflicts: conflictSteps,
    remediation,
    manual,
  };
}
