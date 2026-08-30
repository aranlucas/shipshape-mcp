import type {
  BranchRiskFact,
  DeliveryHygieneFact,
  Evidence as GitHubEvidence,
  RepositoryReadiness,
  SecurityPostureFact,
} from "../github/schemas";
import { makeCheck } from "./rules";
import type { CheckResult, CheckState, Evidence } from "./types";

const evidenceFrom = (items: readonly GitHubEvidence[]): readonly Evidence[] =>
  items.map((item) => ({
    url: item.url,
    label: item.label,
  }));

const observedBoolean = (
  value: boolean | null,
  passWhen: boolean,
): CheckState => {
  if (value === null) return "unknown";
  return value === passWhen ? "pass" : "fail";
};

const settingState = (value: string | null): CheckState => {
  if (value === null) return "unknown";
  if (value === "enabled") return "pass";
  if (value === "disabled") return "fail";
  return "unknown";
};

export const evaluateBranchRisk = (
  branch: BranchRiskFact,
): readonly CheckResult[] => {
  const evidence = evidenceFrom(branch.evidence);
  const protectionState = observedBoolean(branch.protected, true);

  return [
    makeCheck({
      ruleId: "branch.default-protection",
      state: protectionState,
      evidence,
    }),
    makeCheck({
      ruleId: "branch.stale-branch",
      state: "unknown",
      confidence: "low",
      evidence,
      remediation:
        "Inspect the branch's latest commit date before deciding whether it is stale.",
    }),
    makeCheck({
      ruleId: "branch.diverged-default",
      state: "unknown",
      confidence: "low",
      evidence,
      remediation:
        "Compare the branch with the latest default branch before starting follow-up work.",
    }),
    makeCheck({
      ruleId: "branch.open-pr-age",
      state: "unknown",
      confidence: "low",
      evidence,
      remediation:
        "Review the branch's open pull request and its latest activity before scheduling work.",
    }),
  ];
};

export const evaluateDeliveryHygiene = (
  delivery: DeliveryHygieneFact,
): readonly CheckResult[] => {
  const evidence = evidenceFrom(delivery.evidence);
  const ciPresent: CheckState =
    delivery.workflowRuns === null
      ? "unknown"
      : delivery.workflowRuns > 0
        ? "pass"
        : "fail";
  const ciGreen: CheckState =
    delivery.ciStatus === "healthy"
      ? "pass"
      : delivery.ciStatus === "degraded"
        ? "fail"
        : "unknown";

  return [
    makeCheck({ ruleId: "delivery.ci-present", state: ciPresent, evidence }),
    makeCheck({ ruleId: "delivery.ci-green", state: ciGreen, evidence }),
    makeCheck({
      ruleId: "delivery.workflow-pinning",
      state: "unknown",
      confidence: "low",
      evidence,
    }),
    makeCheck({
      ruleId: "delivery.release",
      state: "unknown",
      confidence: "low",
      evidence,
    }),
    makeCheck({
      ruleId: "delivery.dependency-updates",
      state: "unknown",
      confidence: "low",
      evidence,
    }),
  ];
};

export const evaluateSecurityPosture = (
  security: SecurityPostureFact,
  repository: RepositoryReadiness["repository"],
  branch: BranchRiskFact,
): readonly CheckResult[] => {
  const evidence = evidenceFrom([
    ...security.evidence,
    ...repository.evidence,
    ...branch.evidence,
  ]);
  const codeScanning: CheckState =
    security.codeScanning.status === "available" ? "pass" : "unknown";
  const branchControls: CheckState =
    branch.status !== "available"
      ? "unknown"
      : branch.protected === true &&
          branch.requiresPullRequestReviews === true &&
          (branch.requiredStatusChecks ?? 0) > 0
        ? "pass"
        : "fail";

  return [
    makeCheck({
      ruleId: "security.secret-scanning",
      state: settingState(repository.securitySettings.secretScanning),
      evidence,
    }),
    makeCheck({
      ruleId: "security.push-protection",
      state: settingState(repository.securitySettings.pushProtection),
      evidence,
    }),
    makeCheck({
      ruleId: "security.code-scanning",
      state: codeScanning,
      evidence,
    }),
    makeCheck({
      ruleId: "security.dependabot",
      state: "unknown",
      confidence: "low",
      evidence,
      remediation:
        "Verify Dependabot security updates in repository settings; alert visibility alone does not prove updates are enabled.",
    }),
    makeCheck({
      ruleId: "security.branch-protection",
      state: branchControls,
      evidence,
    }),
    makeCheck({
      ruleId: "security.security-policy",
      state: "unknown",
      confidence: "low",
      evidence,
    }),
  ];
};

export const evaluateRepositoryReadiness = (
  readiness: RepositoryReadiness,
): readonly CheckResult[] => {
  const repository = readiness.repository;
  const evidence = evidenceFrom(repository.evidence);
  const publicChecks: readonly CheckResult[] = [
    makeCheck({
      ruleId: "public.description",
      state: repository.description?.trim() ? "pass" : "fail",
      evidence,
    }),
    makeCheck({
      ruleId: "public.readme",
      state: "unknown",
      confidence: "low",
      evidence,
    }),
    makeCheck({
      ruleId: "public.license",
      state: repository.license ? "pass" : "fail",
      evidence,
    }),
    makeCheck({
      ruleId: "public.security-policy",
      state: "unknown",
      confidence: "low",
      evidence,
    }),
    makeCheck({
      ruleId: "public.contributing",
      state: "unknown",
      confidence: "low",
      evidence,
    }),
    makeCheck({
      ruleId: "public.code-of-conduct",
      state: "unknown",
      confidence: "low",
      evidence,
    }),
    makeCheck({
      ruleId: "public.homepage",
      state: "unknown",
      confidence: "low",
      evidence,
    }),
    makeCheck({
      ruleId: "public.topics",
      state: repository.topics.length >= 3 ? "pass" : "fail",
      evidence,
    }),
    makeCheck({
      ruleId: "public.release-notes",
      state: "unknown",
      confidence: "low",
      evidence,
    }),
  ];

  return [
    ...publicChecks,
    ...evaluateBranchRisk(readiness.branchRisk),
    ...evaluateDeliveryHygiene(readiness.deliveryHygiene),
    ...evaluateSecurityPosture(
      readiness.securityPosture,
      readiness.repository,
      readiness.branchRisk,
    ),
  ];
};
