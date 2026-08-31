import {
  CHECK_STATES,
  CONFIDENCE_LEVELS,
  type CheckResult,
  type Confidence,
  type Evidence,
  type MakeCheckInput,
  type RuleDefinition,
} from "./types";

/**
 * Rule identifiers are API.  Once a rule has been emitted, its identifier must
 * never be repurposed: consumers may persist it or use it to suppress an
 * already-triaged recommendation.
 */
export const RULE_IDS = [
  "public.description",
  "public.readme",
  "public.license",
  "public.security-policy",
  "public.contributing",
  "public.code-of-conduct",
  "public.homepage",
  "public.topics",
  "public.release-notes",
  "branch.default-protection",
  "branch.stale-branch",
  "branch.diverged-default",
  "branch.open-pr-age",
  "delivery.ci-present",
  "delivery.ci-green",
  "delivery.workflow-pinning",
  "delivery.release",
  "delivery.dependency-updates",
  "security.secret-scanning",
  "security.push-protection",
  "security.code-scanning",
  "security.dependabot",
  "security.branch-protection",
  "security.security-policy",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

const DEFINITION = (
  id: RuleId,
  category: RuleDefinition["category"],
  title: string,
  description: string,
  remediation: string,
  scoreImpact: number,
  priority: RuleDefinition["priority"],
): RuleDefinition => ({
  id,
  category,
  title,
  description,
  remediation,
  scoreImpact,
  priority,
});

/**
 * The four category budgets each total 100 points.  Scores can therefore be
 * compared within a category even when a caller supplies only that category's
 * checks.  Unknown observations retain their weight but never incur a
 * penalty; the summary confidence communicates the resulting uncertainty.
 */
export const RULE_DEFINITIONS: readonly RuleDefinition[] = [
  DEFINITION(
    "public.description",
    "public_readiness",
    "Repository description",
    "The repository has a concise description that tells a visitor what it does.",
    "Add a one-sentence description that names the problem and the intended audience.",
    10,
    "medium",
  ),
  DEFINITION(
    "public.readme",
    "public_readiness",
    "README",
    "The repository has a useful README with enough context for a new visitor to start.",
    "Add a README covering the purpose, quick start, configuration, and a small usage example.",
    20,
    "high",
  ),
  DEFINITION(
    "public.license",
    "public_readiness",
    "Open-source license",
    "The repository declares a license so users know how they may use and redistribute it.",
    "Add a license file and set the matching repository license metadata.",
    20,
    "high",
  ),
  DEFINITION(
    "public.security-policy",
    "public_readiness",
    "Security policy",
    "The repository explains how to report a vulnerability privately.",
    "Add SECURITY.md with supported versions and a private reporting route.",
    15,
    "high",
  ),
  DEFINITION(
    "public.contributing",
    "public_readiness",
    "Contribution guide",
    "The repository gives prospective contributors a clear path to participate.",
    "Add CONTRIBUTING.md with setup, checks, coding conventions, and the review workflow.",
    10,
    "medium",
  ),
  DEFINITION(
    "public.code-of-conduct",
    "public_readiness",
    "Code of conduct",
    "The repository sets an explicit standard for a welcoming, respectful community.",
    "Add a CODE_OF_CONDUCT.md and name the channel for reporting concerns.",
    5,
    "low",
  ),
  DEFINITION(
    "public.homepage",
    "public_readiness",
    "Project homepage",
    "The repository links to a useful live demo, documentation site, or project page.",
    "Set a verified homepage URL when the project has a public demo or documentation site.",
    5,
    "low",
  ),
  DEFINITION(
    "public.topics",
    "public_readiness",
    "Repository topics",
    "The repository has relevant topics that make it discoverable to the right audience.",
    "Add three to six specific topics describing the stack, problem domain, and project type.",
    5,
    "low",
  ),
  DEFINITION(
    "public.release-notes",
    "public_readiness",
    "Release notes",
    "The project communicates notable changes through releases or a changelog.",
    "Publish a first release or maintain a short CHANGELOG.md with user-facing changes.",
    10,
    "medium",
  ),
  DEFINITION(
    "branch.default-protection",
    "branch_risk",
    "Default branch guardrails",
    "The default branch has guardrails against accidental changes.",
    "Protect the default branch with the smallest guardrails that fit the project, such as blocking accidental force-pushes and deletions.",
    30,
    "critical",
  ),
  DEFINITION(
    "branch.stale-branch",
    "branch_risk",
    "Stale branch",
    "A non-default branch has not received a recent update and may contain abandoned work.",
    "Close, archive, or rebase the branch after confirming that its work is still wanted.",
    25,
    "high",
  ),
  DEFINITION(
    "branch.diverged-default",
    "branch_risk",
    "Branch divergence",
    "A branch is substantially ahead of or behind the default branch.",
    "Rebase or merge the default branch, then run the full verification suite before review.",
    25,
    "high",
  ),
  DEFINITION(
    "branch.open-pr-age",
    "branch_risk",
    "Aging pull request",
    "An open pull request has been waiting long enough to become a delivery risk.",
    "Review the pull request, resolve blockers, or close it with a short decision note.",
    20,
    "medium",
  ),
  DEFINITION(
    "delivery.ci-present",
    "delivery_hygiene",
    "Continuous integration",
    "The repository has an automated check that runs for proposed changes.",
    "Add a small CI workflow that installs locked dependencies and runs the project gates.",
    25,
    "critical",
  ),
  DEFINITION(
    "delivery.ci-green",
    "delivery_hygiene",
    "Recent CI health",
    "The most recent relevant CI run completed successfully.",
    "Inspect the latest failed run, fix the root cause, and keep the default branch green.",
    25,
    "critical",
  ),
  DEFINITION(
    "delivery.workflow-pinning",
    "delivery_hygiene",
    "Pinned workflow actions",
    "Third-party GitHub Actions are pinned to immutable commit SHAs.",
    "Pin every third-party action to a full commit SHA and leave a human-readable version comment.",
    20,
    "high",
  ),
  DEFINITION(
    "delivery.release",
    "delivery_hygiene",
    "Reproducible release",
    "The project has a recent release or artifact that makes a known version consumable.",
    "Create a tagged release with notes and a reproducible artifact when the project is distributable.",
    15,
    "medium",
  ),
  DEFINITION(
    "delivery.dependency-updates",
    "delivery_hygiene",
    "Dependency update path",
    "The project has a documented or automated way to keep dependencies current.",
    "Add a Dependabot configuration or an equivalent scheduled dependency-update process.",
    15,
    "medium",
  ),
  DEFINITION(
    "security.secret-scanning",
    "security_posture",
    "Secret scanning",
    "GitHub secret scanning is enabled for the repository.",
    "Enable secret scanning and investigate any existing alerts before making the repository public.",
    22,
    "critical",
  ),
  DEFINITION(
    "security.push-protection",
    "security_posture",
    "Push protection",
    "GitHub blocks newly detected secrets before they reach the repository.",
    "Enable push protection after confirming that legitimate test fixtures are safely redacted.",
    18,
    "critical",
  ),
  DEFINITION(
    "security.code-scanning",
    "security_posture",
    "Code scanning",
    "An automated static-analysis workflow is configured for the repository.",
    "Enable CodeQL or an equivalent scanner and review its first results.",
    18,
    "high",
  ),
  DEFINITION(
    "security.dependabot",
    "security_posture",
    "Dependabot security updates",
    "The repository has an automated path for vulnerable dependency updates.",
    "Enable Dependabot security updates and review the generated pull requests.",
    14,
    "high",
  ),
  DEFINITION(
    "security.branch-protection",
    "security_posture",
    "Security branch controls",
    "The default branch has baseline controls against accidental changes.",
    "Enable default-branch protection with the smallest safeguards that fit this repository, including blocking accidental force-pushes and deletions.",
    18,
    "high",
  ),
  DEFINITION(
    "security.security-policy",
    "security_posture",
    "Vulnerability disclosure",
    "The project publishes a private vulnerability-disclosure process.",
    "Add SECURITY.md with supported versions and a private contact or security advisory route.",
    10,
    "medium",
  ),
] as const;

const RULE_INDEX = new Map<string, RuleDefinition>(
  RULE_DEFINITIONS.map((definition) => [definition.id, definition]),
);

const MAX_EVIDENCE = 8;
const MAX_LABEL_LENGTH = 160;
const MAX_DETAIL_LENGTH = 320;
const MAX_REMEDIATION_LENGTH = 500;

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const truncate = (value: string, maxLength: number): string =>
  value.length > maxLength
    ? value.slice(0, maxLength - 1).trimEnd() + "…"
    : value;

const canonicalHttpUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
};

const normalizedEvidence = (evidence: Evidence): Evidence | null => {
  if (!evidence || typeof evidence !== "object") {
    return null;
  }
  const rawUrl = typeof evidence.url === "string" ? evidence.url.trim() : "";
  const url = canonicalHttpUrl(rawUrl);
  if (!url) {
    return null;
  }

  const label = typeof evidence.label === "string" ? evidence.label.trim() : "";
  const detail =
    typeof evidence.detail === "string" ? evidence.detail.trim() : "";
  return {
    url,
    label: truncate(label || url, MAX_LABEL_LENGTH),
    ...(detail ? { detail: truncate(detail, MAX_DETAIL_LENGTH) } : {}),
  };
};

/**
 * Normalize evidence before it is included in a result.  URL is the identity
 * key: duplicate observations are collapsed and the lexicographically stable
 * description wins, regardless of provider response order.
 */
export const dedupeEvidence = (
  evidence: readonly Evidence[] | undefined,
): readonly Evidence[] => {
  const byUrl = new Map<string, Evidence>();
  for (const item of evidence ?? []) {
    const normalized = normalizedEvidence(item);
    if (!normalized) {
      continue;
    }
    const existing = byUrl.get(normalized.url);
    if (
      !existing ||
      compareStrings(
        `${normalized.label}\u0000${normalized.detail ?? ""}`,
        `${existing.label}\u0000${existing.detail ?? ""}`,
      ) < 0
    ) {
      byUrl.set(normalized.url, normalized);
    }
  }

  return [...byUrl.values()]
    .sort((left, right) => compareStrings(left.url, right.url))
    .slice(0, MAX_EVIDENCE);
};

export const getRuleDefinition = (ruleId: string): RuleDefinition | undefined =>
  RULE_INDEX.get(ruleId);

export const requireRuleDefinition = (ruleId: string): RuleDefinition => {
  const definition = getRuleDefinition(ruleId);
  if (!definition) {
    throw new RangeError(`Unknown rule identifier: ${ruleId}`);
  }
  return definition;
};

const isCheckState = (value: string): value is CheckResult["state"] =>
  (CHECK_STATES as readonly string[]).includes(value);

const isConfidence = (value: string): value is Confidence =>
  (CONFIDENCE_LEVELS as readonly string[]).includes(value);

const defaultConfidence = (state: CheckResult["state"]): Confidence =>
  state === "unknown" ? "low" : "high";

/**
 * Build a result from a stable rule.  Evaluators can override confidence and
 * the next-step wording, but never the rule's category, priority, or weight.
 */
export const makeCheck = (input: MakeCheckInput): CheckResult => {
  const definition = requireRuleDefinition(input.ruleId);
  if (!isCheckState(input.state)) {
    throw new RangeError(`Invalid check state: ${String(input.state)}`);
  }
  if (input.confidence !== undefined && !isConfidence(input.confidence)) {
    throw new RangeError(`Invalid confidence: ${String(input.confidence)}`);
  }

  const remediation =
    typeof input.remediation === "string" && input.remediation.trim()
      ? truncate(input.remediation.trim(), MAX_REMEDIATION_LENGTH)
      : definition.remediation;

  return {
    ruleId: definition.id,
    category: definition.category,
    title: definition.title,
    state: input.state,
    confidence: input.confidence ?? defaultConfidence(input.state),
    remediation,
    scoreImpact: definition.scoreImpact,
    priority: definition.priority,
    evidence: dedupeEvidence(input.evidence),
  };
};

export const categoryForRule = (ruleId: string): RuleDefinition["category"] =>
  requireRuleDefinition(ruleId).category;

export const priorityForRule = (ruleId: string): RuleDefinition["priority"] =>
  requireRuleDefinition(ruleId).priority;

export { MAX_EVIDENCE };
