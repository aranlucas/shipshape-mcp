import { makeCheck, RULE_DEFINITIONS, type RuleId } from "./rules";
import {
  CONFIDENCE_LEVELS,
  PRIORITY_LEVELS,
  RULE_CATEGORIES,
  type ActionItem,
  type ActionPlan,
  type ActionPlanOptions,
  type CategoryRollup,
  type CheckResult,
  type CheckState,
  type Confidence,
  type Evidence,
  type RuleCategory,
  type ScoreSummary,
  type StateCounts,
} from "./types";

const CATEGORY_ORDER = new Map<RuleCategory, number>(
  RULE_CATEGORIES.map((category, index) => [category, index]),
);

const PRIORITY_ORDER = new Map(
  PRIORITY_LEVELS.map((priority, index) => [
    priority,
    PRIORITY_LEVELS.length - index,
  ]),
);

const CONFIDENCE_ORDER = new Map(
  CONFIDENCE_LEVELS.map((confidence, index) => [
    confidence,
    CONFIDENCE_LEVELS.length - index,
  ]),
);

const STATE_ORDER = new Map<CheckState, number>([
  ["fail", 4],
  ["unknown", 3],
  ["pass", 2],
  ["not_applicable", 1],
]);

const DEFAULT_MAX_ACTIONS = 20;
const MAX_ACTIONS = 50;

type MutableStateCounts = {
  -readonly [Key in keyof StateCounts]: StateCounts[Key];
};

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareNumbersDescending = (left: number, right: number): number =>
  right - left;

const emptyCounts = (): MutableStateCounts => ({
  pass: 0,
  fail: 0,
  unknown: 0,
  not_applicable: 0,
});

const countStates = (checks: readonly CheckResult[]): StateCounts => {
  const counts = emptyCounts();
  for (const check of checks) {
    counts[check.state] += 1;
  }
  return counts;
};

const minimumConfidence = (checks: readonly CheckResult[]): Confidence => {
  const applicable = checks.filter((check) => check.state !== "not_applicable");
  if (applicable.length === 0) {
    return "low";
  }

  let confidenceRank: number = CONFIDENCE_LEVELS.length;
  for (const check of applicable) {
    confidenceRank = Math.min(
      confidenceRank,
      CONFIDENCE_ORDER.get(check.confidence) ?? 1,
    );
  }

  // A permission or provider failure is uncertainty even if a caller labels
  // the fallback observation highly.  Never advertise high confidence when
  // any applicable rule is unknown.
  if (applicable.some((check) => check.state === "unknown")) {
    confidenceRank = Math.min(confidenceRank, 2);
  }

  return CONFIDENCE_LEVELS[CONFIDENCE_LEVELS.length - confidenceRank];
};

const scoreFor = (
  checks: readonly CheckResult[],
): Pick<
  ScoreSummary,
  "score" | "totalImpact" | "failedImpact" | "observedImpact"
> => {
  const applicable = checks.filter((check) => check.state !== "not_applicable");
  let totalImpact = 0;
  let failedImpact = 0;
  let observedImpact = 0;

  for (const check of applicable) {
    totalImpact += check.scoreImpact;
    if (check.state === "fail") {
      failedImpact += check.scoreImpact;
    }
    if (check.state === "pass" || check.state === "fail") {
      observedImpact += check.scoreImpact;
    }
  }

  if (totalImpact === 0) {
    return { score: null, totalImpact, failedImpact, observedImpact };
  }

  const rawScore = ((totalImpact - failedImpact) / totalImpact) * 100;
  return {
    score: Math.max(0, Math.min(100, Math.round(rawScore))),
    totalImpact,
    failedImpact,
    observedImpact,
  };
};

const canonicalEvidence = (
  evidence: unknown,
): readonly Evidence[] | undefined =>
  Array.isArray(evidence) ? (evidence as readonly Evidence[]) : undefined;

const canonicalCheck = (check: CheckResult): CheckResult => {
  if (!check || typeof check !== "object") {
    throw new TypeError("A check result must be an object");
  }

  // Rebuild provider-supplied metadata from the rule catalog.  This prevents
  // an evaluator from accidentally (or maliciously) changing a rule's
  // category, priority, or weight in the final score.
  return makeCheck({
    ruleId: check.ruleId,
    state: check.state,
    confidence: check.confidence,
    remediation: check.remediation,
    evidence: canonicalEvidence(check.evidence),
  });
};

const checkTieBreakKey = (check: CheckResult): string =>
  [
    check.remediation,
    check.title,
    ...check.evidence.flatMap((evidence) => [
      evidence.url,
      evidence.label,
      evidence.detail ?? "",
    ]),
  ].join("\u0000");

const preferredDuplicate = (
  current: CheckResult,
  candidate: CheckResult,
): CheckResult => {
  const stateDifference =
    (STATE_ORDER.get(candidate.state) ?? 0) -
    (STATE_ORDER.get(current.state) ?? 0);
  if (stateDifference !== 0) {
    return stateDifference > 0 ? candidate : current;
  }

  const confidenceDifference =
    (CONFIDENCE_ORDER.get(candidate.confidence) ?? 0) -
    (CONFIDENCE_ORDER.get(current.confidence) ?? 0);
  if (confidenceDifference !== 0) {
    return confidenceDifference > 0 ? candidate : current;
  }

  return compareStrings(
    checkTieBreakKey(candidate),
    checkTieBreakKey(current),
  ) < 0
    ? candidate
    : current;
};

const compareChecks = (left: CheckResult, right: CheckResult): number => {
  const categoryDifference =
    (CATEGORY_ORDER.get(left.category) ?? Number.MAX_SAFE_INTEGER) -
    (CATEGORY_ORDER.get(right.category) ?? Number.MAX_SAFE_INTEGER);
  return categoryDifference || compareStrings(left.ruleId, right.ruleId);
};

/**
 * Canonicalize, deduplicate, and stably order a set of checks.  Duplicate
 * rule IDs are resolved conservatively: fail beats unknown, unknown beats
 * pass, and pass beats not_applicable.  Ties prefer stronger confidence and
 * finally a lexical key, so provider response ordering cannot change output.
 */
export const normalizeChecks = (
  checks: readonly CheckResult[],
): readonly CheckResult[] => {
  const byRuleId = new Map<string, CheckResult>();
  for (const input of checks) {
    const candidate = canonicalCheck(input);
    const current = byRuleId.get(candidate.ruleId);
    byRuleId.set(
      candidate.ruleId,
      current ? preferredDuplicate(current, candidate) : candidate,
    );
  }

  return [...byRuleId.values()].sort(compareChecks);
};

const rollupFor = (
  category: RuleCategory,
  checks: readonly CheckResult[],
): CategoryRollup => {
  const score = scoreFor(checks);
  return {
    category,
    score: score.score,
    checkCount: checks.length,
    counts: countStates(checks),
    totalImpact: score.totalImpact,
    failedImpact: score.failedImpact,
    observedImpact: score.observedImpact,
    confidence: minimumConfidence(checks),
  };
};

/**
 * Calculate a normalized 0-100 score.  Each failed rule spends its fixed
 * impact; unknown rules retain their weight but spend no points, while
 * not_applicable rules are excluded.  This keeps a permission failure from
 * looking like a repository defect while making uncertainty visible.
 */
export const scoreChecks = (checks: readonly CheckResult[]): ScoreSummary => {
  const normalized = normalizeChecks(checks);
  const score = scoreFor(normalized);
  const categories = RULE_CATEGORIES.flatMap((category) => {
    const categoryChecks = normalized.filter(
      (check) => check.category === category,
    );
    return categoryChecks.length > 0
      ? [rollupFor(category, categoryChecks)]
      : [];
  });

  return {
    score: score.score,
    checkCount: normalized.length,
    counts: countStates(normalized),
    totalImpact: score.totalImpact,
    failedImpact: score.failedImpact,
    observedImpact: score.observedImpact,
    confidence: minimumConfidence(normalized),
    checks: normalized,
    categories,
  };
};

const actionStateOrder = (state: ActionItem["state"]): number =>
  state === "fail" ? 2 : 1;

const compareActions = (left: CheckResult, right: CheckResult): number => {
  const stateDifference =
    actionStateOrder(left.state as ActionItem["state"]) -
    actionStateOrder(right.state as ActionItem["state"]);
  if (stateDifference !== 0) {
    return -stateDifference;
  }

  const priorityDifference =
    (PRIORITY_ORDER.get(right.priority) ?? 0) -
    (PRIORITY_ORDER.get(left.priority) ?? 0);
  if (priorityDifference !== 0) {
    return priorityDifference;
  }

  const impactDifference = compareNumbersDescending(
    left.scoreImpact,
    right.scoreImpact,
  );
  if (impactDifference !== 0) {
    return impactDifference;
  }

  const confidenceDifference =
    (CONFIDENCE_ORDER.get(right.confidence) ?? 0) -
    (CONFIDENCE_ORDER.get(left.confidence) ?? 0);
  if (confidenceDifference !== 0) {
    return confidenceDifference;
  }

  return compareChecks(left, right);
};

const maxActionCount = (value: number | undefined): number => {
  if (value === undefined) {
    return DEFAULT_MAX_ACTIONS;
  }
  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_ACTIONS;
  }
  return Math.max(0, Math.min(MAX_ACTIONS, Math.floor(value)));
};

/** Rank failed and unknown rules into a bounded, deterministic work queue. */
export const buildActionPlan = (
  checks: readonly CheckResult[],
  options?: ActionPlanOptions,
): ActionPlan => {
  const normalized = normalizeChecks(checks);
  const actionable = normalized
    .filter(
      (check): check is CheckResult & { state: "fail" | "unknown" } =>
        check.state === "fail" || check.state === "unknown",
    )
    .sort(compareActions);
  const limit = maxActionCount(options?.maxItems);

  const items: ActionItem[] = actionable
    .slice(0, limit)
    .map((check, index) => ({
      rank: index + 1,
      ruleId: check.ruleId,
      category: check.category,
      title: check.title,
      state: check.state,
      confidence: check.confidence,
      priority: check.priority,
      remediation: check.remediation,
      scoreImpact: check.scoreImpact,
      evidence: check.evidence,
    }));

  return {
    items,
    omittedCount: actionable.length - items.length,
  };
};

export const categoryRollup = (
  category: RuleCategory,
  checks: readonly CheckResult[],
): CategoryRollup => {
  const normalized = normalizeChecks(checks).filter(
    (check) => check.category === category,
  );
  return rollupFor(category, normalized);
};

export { CATEGORY_ORDER, MAX_ACTIONS, PRIORITY_ORDER, RULE_DEFINITIONS };

export type { RuleId };
