/**
 * The domain model deliberately contains no GitHub or Worker types.  Audits
 * turn provider observations into these values before they reach scoring, so
 * the scoring contract remains deterministic and easy to test.
 */

export const CHECK_STATES = [
  "pass",
  "fail",
  "unknown",
  "not_applicable",
] as const;

export type CheckState = (typeof CHECK_STATES)[number];

export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;

export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const RULE_CATEGORIES = [
  "public_readiness",
  "branch_risk",
  "delivery_hygiene",
  "security_posture",
] as const;

export type RuleCategory = (typeof RULE_CATEGORIES)[number];

export const PRIORITY_LEVELS = ["critical", "high", "medium", "low"] as const;

export type Priority = (typeof PRIORITY_LEVELS)[number];

/** A stable reference to an observation in the provider's public UI/API. */
export interface Evidence {
  readonly url: string;
  readonly label: string;
  readonly detail?: string;
}

/**
 * A rule's maximum contribution to score.  It is a positive penalty, not a
 * signed delta: a failed check spends this many points, while pass and
 * unknown checks spend zero.  Keeping this convention in the public model
 * makes rule impacts understandable in tool output.
 */
export interface RuleDefinition {
  readonly id: string;
  readonly category: RuleCategory;
  readonly title: string;
  readonly description: string;
  readonly remediation: string;
  readonly scoreImpact: number;
  readonly priority: Priority;
}

/** One normalized, provider-independent audit result. */
export interface CheckResult {
  readonly ruleId: string;
  readonly category: RuleCategory;
  readonly title: string;
  readonly state: CheckState;
  readonly confidence: Confidence;
  readonly remediation: string;
  /** Maximum points this rule can cost when it fails. */
  readonly scoreImpact: number;
  readonly priority: Priority;
  readonly evidence: readonly Evidence[];
}

export interface StateCounts {
  readonly pass: number;
  readonly fail: number;
  readonly unknown: number;
  readonly not_applicable: number;
}

export interface CategoryRollup {
  readonly category: RuleCategory;
  readonly score: number | null;
  readonly checkCount: number;
  readonly counts: StateCounts;
  /** Total impact of applicable rules, including unknown observations. */
  readonly totalImpact: number;
  /** Impact of failed rules only. */
  readonly failedImpact: number;
  /** Impact from pass/fail observations, excluding unknown rules. */
  readonly observedImpact: number;
  readonly confidence: Confidence;
}

export interface ScoreSummary {
  /** Null means the input had no applicable rules to score. */
  readonly score: number | null;
  readonly checkCount: number;
  readonly counts: StateCounts;
  readonly totalImpact: number;
  readonly failedImpact: number;
  readonly observedImpact: number;
  readonly confidence: Confidence;
  readonly checks: readonly CheckResult[];
  readonly categories: readonly CategoryRollup[];
}

export interface ActionItem {
  readonly rank: number;
  readonly ruleId: string;
  readonly category: RuleCategory;
  readonly title: string;
  readonly state: Extract<CheckState, "fail" | "unknown">;
  readonly confidence: Confidence;
  readonly priority: Priority;
  readonly remediation: string;
  readonly scoreImpact: number;
  readonly evidence: readonly Evidence[];
}

export interface ActionPlan {
  readonly items: readonly ActionItem[];
  readonly omittedCount: number;
}

export interface MakeCheckInput {
  readonly ruleId: string;
  readonly state: CheckState;
  readonly evidence?: readonly Evidence[];
  readonly confidence?: Confidence;
  /** Allows an evaluator to explain an intentionally different next step. */
  readonly remediation?: string;
}

export interface ActionPlanOptions {
  /** Maximum number of actions returned. Defaults to 20 and is capped at 50. */
  readonly maxItems?: number;
}
