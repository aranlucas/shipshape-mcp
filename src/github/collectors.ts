import pLimit from "p-limit";

import {
  GitHubInputError,
  MAX_ALLOWED_CONCURRENCY,
  PrivateRepositoryError,
  octokitGet,
  octokitPaginate,
  type GitHubOctokit,
} from "./client";
import {
  GitHubBranchProtectionSchema,
  GitHubBranchSchema,
  GitHubCodeScanningAlertSchema,
  GitHubCommitSchema,
  GitHubDependabotAlertSchema,
  GitHubPullRequestSchema,
  GitHubRepositorySchema,
  GitHubSecretScanningAlertSchema,
  GitHubWorkflowRunSchema,
  GitHubOwnerInputSchema,
  GitHubRefInputSchema,
  RepositoryCoordinatesSchema,
  type ActionPlanItem,
  type ActionPriority,
  type BranchRiskFact,
  type CollectionStatus,
  type DeliveryHygieneFact,
  type Evidence,
  type FeatureResult,
  type GitHubBranchProtection,
  type GitHubCodeScanningAlert,
  type GitHubDependabotAlert,
  type GitHubRepository,
  type GitHubResponseMetadata,
  type GitHubSecretScanningAlert,
  type GitHubWorkflowRun,
  type PortfolioSnapshot,
  type RepoReadinessFact,
  type RepositoryCoordinates,
  type RepositoryFact,
  type RepositoryReadiness,
  type SecurityPostureFact,
} from "./schemas";

export interface CollectorOptions {
  maxPages?: number;
  perPage?: number;
  concurrency?: number;
  since?: string;
  until?: string;
  signal?: AbortSignal;
}

export interface PortfolioSnapshotOptions extends CollectorOptions {
  /** Explicit repositories avoid a second owner listing request. */
  repositories?: readonly RepositoryCoordinates[];
}

type EndpointResult<T> = {
  value: T | null;
  metadata: GitHubResponseMetadata | null;
  error: unknown;
};

const DEFAULT_RECENT_DAYS = 30;

function concurrencyLimit(value: number | undefined, fallback: number) {
  const concurrency = value ?? fallback;
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new GitHubInputError("concurrency must be a positive integer");
  }
  return pLimit(Math.min(concurrency, MAX_ALLOWED_CONCURRENCY));
}

function nowIso(): string {
  return new Date().toISOString();
}

function webRepositoryUrl(repository: RepositoryCoordinates): string {
  return `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
}

function branchEvidence(
  repository: RepositoryCoordinates,
  branch: string,
  collectedAt: string,
): Evidence {
  return {
    url: `${webRepositoryUrl(repository)}/tree/${encodeURIComponent(branch)}`,
    label: `${repository.owner}/${repository.repo} ${branch} branch`,
    collectedAt,
  };
}

function featureEvidence(
  url: string,
  label: string,
  collectedAt: string,
): Evidence {
  return { url, label, collectedAt };
}

function endpointMetadata(_error: unknown): GitHubResponseMetadata | null {
  return null;
}

function errorReason(error: unknown): string {
  if (
    error instanceof Error &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    const status = error.status;
    if (status === 403 || status === 404) {
      return `GitHub feature unavailable or permission-limited (HTTP ${status})`;
    }
    return `GitHub request failed (HTTP ${status})`;
  }
  if (error instanceof Error) return error.message;
  return "GitHub feature could not be collected";
}

function featureFailure<T>(
  error: unknown,
  evidence: Evidence[],
): FeatureResult<T> {
  return {
    status: "unknown",
    value: null,
    reason: errorReason(error),
    evidence,
    metadata: endpointMetadata(error),
  };
}

function featureSuccess<T>(
  value: T,
  metadata: GitHubResponseMetadata | null,
  evidence: Evidence[],
): FeatureResult<T> {
  return {
    status: "available",
    value,
    reason: null,
    evidence,
    metadata,
  };
}

async function endpoint<T>(
  worker: () => Promise<{ data: T; metadata: GitHubResponseMetadata }>,
): Promise<EndpointResult<T>> {
  try {
    const response = await worker();
    return { value: response.data, metadata: response.metadata, error: null };
  } catch (error) {
    return { value: null, metadata: endpointMetadata(error), error };
  }
}

function repositoryFact(
  repository: RepositoryCoordinates,
  value: GitHubRepository,
  collectedAt: string,
): RepositoryFact {
  const security = value.security_and_analysis;
  return {
    coordinates: repository,
    fullName: value.full_name,
    name: value.name,
    description: value.description ?? null,
    defaultBranch: GitHubRefInputSchema.parse(value.default_branch),
    visibility: value.visibility ?? (value.private ? "private" : "public"),
    archived: value.archived,
    fork: value.fork,
    language: value.language ?? null,
    license:
      value.license?.spdx_id ??
      value.license?.key ??
      value.license?.name ??
      null,
    topics: value.topics ?? [],
    stars: value.stargazers_count ?? null,
    forks: value.forks_count ?? null,
    openIssues: value.open_issues_count ?? null,
    createdAt: value.created_at ?? null,
    updatedAt: value.updated_at ?? null,
    pushedAt: value.pushed_at ?? null,
    pullRequestSettings: {
      allowMergeCommit: value.allow_merge_commit ?? null,
      allowRebaseMerge: value.allow_rebase_merge ?? null,
      allowUpdateBranch: value.allow_update_branch ?? null,
    },
    securitySettings: {
      advancedSecurity: security?.advanced_security?.status ?? null,
      secretScanning: security?.secret_scanning?.status ?? null,
      pushProtection: security?.secret_scanning_push_protection?.status ?? null,
    },
    evidence: [
      featureEvidence(
        value.html_url,
        `${value.full_name} repository`,
        collectedAt,
      ),
    ],
  };
}

function protectionCheckCount(protection: GitHubBranchProtection): number {
  const checks = protection.required_status_checks;
  if (!checks) return 0;
  return checks.checks?.length ?? checks.contexts?.length ?? 0;
}

function branchProtectionEvidence(
  repository: RepositoryCoordinates,
  branch: string,
  collectedAt: string,
): Evidence {
  return featureEvidence(
    `${webRepositoryUrl(repository)}/settings/branches`,
    `${repository.owner}/${repository.repo} branch protection`,
    collectedAt,
  );
}

export async function collectBranchRisk(
  client: GitHubOctokit,
  repository: RepositoryCoordinates,
  branch: string,
  options: CollectorOptions = {},
): Promise<BranchRiskFact> {
  const coordinates = RepositoryCoordinatesSchema.parse(repository);
  const ref = GitHubRefInputSchema.parse(branch);
  const collectedAt = nowIso();
  const evidence = [branchEvidence(coordinates, ref, collectedAt)];
  const branchResult = await endpoint(() =>
    octokitGet(
      client,
      "GET /repos/{owner}/{repo}/branches/{branch}",
      { ...coordinates, branch: ref, ...requestOptions(options) },
      GitHubBranchSchema,
    ),
  );

  if (!branchResult.value) {
    return {
      branch: ref,
      protected: null,
      protectionStatus: "unknown",
      requiresPullRequestReviews: null,
      requiredApprovingReviews: null,
      requiredStatusChecks: null,
      enforceAdmins: null,
      allowsForcePushes: null,
      allowsDeletions: null,
      status: "unknown",
      reason: errorReason(branchResult.error),
      evidence,
    };
  }

  const protectionResult = await endpoint(() =>
    octokitGet(
      client,
      "GET /repos/{owner}/{repo}/branches/{branch}/protection",
      { ...coordinates, branch: ref, ...requestOptions(options) },
      GitHubBranchProtectionSchema,
    ),
  );
  if (!protectionResult.value) {
    return {
      branch: ref,
      protected: branchResult.value.protected ?? null,
      protectionStatus: "unknown",
      requiresPullRequestReviews: null,
      requiredApprovingReviews: null,
      requiredStatusChecks: null,
      enforceAdmins: null,
      allowsForcePushes: null,
      allowsDeletions: null,
      status: "partial",
      reason: errorReason(protectionResult.error),
      evidence: [
        ...evidence,
        branchProtectionEvidence(coordinates, ref, collectedAt),
      ],
    };
  }

  const protection = protectionResult.value;
  const reviews = protection.required_pull_request_reviews;
  return {
    branch: ref,
    protected: branchResult.value.protected ?? true,
    protectionStatus: "protected",
    requiresPullRequestReviews: reviews !== null && reviews !== undefined,
    requiredApprovingReviews: reviews?.required_approving_review_count ?? null,
    requiredStatusChecks: protectionCheckCount(protection),
    enforceAdmins: protection.enforce_admins?.enabled ?? null,
    allowsForcePushes: protection.allow_force_pushes ?? null,
    allowsDeletions: protection.allow_deletions ?? null,
    status: "available",
    reason: null,
    evidence: [
      ...evidence,
      branchProtectionEvidence(coordinates, ref, collectedAt),
    ],
  };
}

function recentSince(options: CollectorOptions): string {
  if (options.since) return options.since;
  return new Date(
    Date.now() - DEFAULT_RECENT_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
}

export async function collectDeliveryHygiene(
  client: GitHubOctokit,
  repository: RepositoryCoordinates,
  branch: string,
  options: CollectorOptions = {},
): Promise<DeliveryHygieneFact> {
  const coordinates = RepositoryCoordinatesSchema.parse(repository);
  const ref = GitHubRefInputSchema.parse(branch);
  const collectedAt = nowIso();
  const request = requestOptions(options);
  const limit = concurrencyLimit(options.concurrency, 3);
  const [commits, pullRequests, workflowRuns] = await Promise.all([
    limit(() =>
      endpoint(() =>
        octokitPaginate(
          client,
          "GET /repos/{owner}/{repo}/commits",
          {
            ...coordinates,
            ...request,
            sha: ref,
            since: recentSince(options),
            until: options.until,
          },
          GitHubCommitSchema,
          paginationOptions(options),
        ),
      ),
    ),
    limit(() =>
      endpoint(() =>
        octokitPaginate(
          client,
          "GET /repos/{owner}/{repo}/pulls",
          { ...coordinates, ...request, state: "open" },
          GitHubPullRequestSchema,
          paginationOptions(options),
        ),
      ),
    ),
    limit(() =>
      endpoint(() =>
        octokitPaginate(
          client,
          "GET /repos/{owner}/{repo}/actions/runs",
          {
            ...coordinates,
            ...request,
            branch: ref,
          },
          GitHubWorkflowRunSchema,
          paginationOptions(options),
        ),
      ),
    ),
  ]);

  const evidence: Evidence[] = [
    featureEvidence(
      `${webRepositoryUrl(coordinates)}/commits/${encodeURIComponent(ref)}`,
      `${coordinates.owner}/${coordinates.repo} commits`,
      collectedAt,
    ),
    featureEvidence(
      `${webRepositoryUrl(coordinates)}/pulls`,
      `${coordinates.owner}/${coordinates.repo} pull requests`,
      collectedAt,
    ),
    featureEvidence(
      `${webRepositoryUrl(coordinates)}/actions`,
      `${coordinates.owner}/${coordinates.repo} Actions`,
      collectedAt,
    ),
  ];
  const reasons = [commits, pullRequests, workflowRuns]
    .filter((result) => result.error !== null)
    .map((result) => errorReason(result.error));
  const availableCount = [commits, pullRequests, workflowRuns].filter(
    (result) => result.value !== null,
  ).length;
  const commitItems = commits.value ?? [];
  const pullItems = pullRequests.value ?? [];
  const runItems = workflowRuns.value ?? [];
  const failedConclusions = new Set([
    "action_required",
    "failure",
    "startup_failure",
    "timed_out",
  ]);
  const failedWorkflowRuns = runItems.filter(
    (run) =>
      typeof run.conclusion === "string" &&
      failedConclusions.has(run.conclusion),
  ).length;
  const cancelledWorkflowRuns = runItems.filter(
    (run) => run.conclusion === "cancelled",
  ).length;
  const inProgressWorkflowRuns = runItems.filter(
    (run) => run.status !== null && run.status !== "completed",
  ).length;
  const successfulWorkflowRuns = runItems.filter(
    (run) => run.conclusion === "success",
  ).length;
  const latestCommitAt =
    commitItems
      .map(
        (commit) =>
          commit.commit.author?.date ?? commit.commit.committer?.date ?? null,
      )
      .filter((date): date is string => date !== null)
      .sort()
      .at(-1) ?? null;
  const latestRun = runItems[0];
  const summarizeRun = (run: GitHubWorkflowRun) => ({
    id: run.id,
    name: run.name ?? null,
    event: run.event ?? null,
    headBranch: run.head_branch ?? null,
    headSha: run.head_sha ?? null,
    status: run.status ?? null,
    conclusion: run.conclusion ?? null,
    createdAt: run.created_at ?? null,
    updatedAt: run.updated_at ?? null,
    url: run.html_url,
  });
  const latestWorkflowRun = latestRun ? summarizeRun(latestRun) : null;
  const latestCompletedByWorkflow = new Map<string, GitHubWorkflowRun>();
  for (const run of runItems) {
    if (run.status !== "completed" || run.conclusion === "cancelled") continue;
    const workflow = run.name ?? run.html_url;
    if (!latestCompletedByWorkflow.has(workflow))
      latestCompletedByWorkflow.set(workflow, run);
  }
  const failingWorkflowRuns = [...latestCompletedByWorkflow.values()]
    .filter(
      (run) =>
        typeof run.conclusion === "string" &&
        failedConclusions.has(run.conclusion),
    )
    .slice(0, 5)
    .map(summarizeRun);
  if (latestRun?.html_url)
    evidence.push(
      featureEvidence(latestRun.html_url, "Latest workflow run", collectedAt),
    );
  for (const run of failingWorkflowRuns) {
    evidence.push(
      featureEvidence(
        run.url,
        `${run.name ?? "Workflow"} ${run.conclusion ?? "failed"} on ${run.event ?? "unknown event"} at ${run.createdAt ?? "unknown time"}`,
        collectedAt,
      ),
    );
  }
  if (commitItems[0]?.html_url)
    evidence.push(
      featureEvidence(commitItems[0].html_url, "Latest commit", collectedAt),
    );

  let ciStatus: DeliveryHygieneFact["ciStatus"] = "unknown";
  if (workflowRuns.value && latestCompletedByWorkflow.size > 0)
    ciStatus = [...latestCompletedByWorkflow.values()].some(
      (run) =>
        typeof run.conclusion === "string" &&
        failedConclusions.has(run.conclusion),
    )
      ? "degraded"
      : "healthy";
  const status: CollectionStatus =
    availableCount === 3
      ? "available"
      : availableCount === 0
        ? "unknown"
        : "partial";
  return {
    recentCommits: commits.value ? commitItems.length : null,
    latestCommitAt,
    openPullRequests: pullRequests.value ? pullItems.length : null,
    draftPullRequests: pullRequests.value
      ? pullItems.filter((pull) => pull.draft === true).length
      : null,
    workflowRuns: workflowRuns.value ? runItems.length : null,
    successfulWorkflowRuns: workflowRuns.value ? successfulWorkflowRuns : null,
    failedWorkflowRuns: workflowRuns.value ? failedWorkflowRuns : null,
    cancelledWorkflowRuns: workflowRuns.value ? cancelledWorkflowRuns : null,
    inProgressWorkflowRuns: workflowRuns.value ? inProgressWorkflowRuns : null,
    latestWorkflowRun: workflowRuns.value ? latestWorkflowRun : null,
    failingWorkflowRuns: workflowRuns.value ? failingWorkflowRuns : null,
    ciStatus,
    status,
    reason: reasons.length > 0 ? reasons.join("; ") : null,
    evidence,
  };
}

function securityFeatureEvidence(
  repository: RepositoryCoordinates,
  feature: "codeScanning" | "dependabot" | "secretScanning",
  collectedAt: string,
): Evidence[] {
  const root = webRepositoryUrl(repository);
  const details = {
    codeScanning: [`${root}/security/code-scanning`, "Code scanning alerts"],
    dependabot: [`${root}/security/dependabot`, "Dependabot alerts"],
    secretScanning: [
      `${root}/security/secret-scanning`,
      "Secret scanning alerts",
    ],
  } as const;
  const [url, label] = details[feature];
  return [featureEvidence(url, label, collectedAt)];
}

async function collectCodeScanning(
  client: GitHubOctokit,
  repository: RepositoryCoordinates,
  options: CollectorOptions,
  collectedAt: string,
): Promise<FeatureResult<{ openAlerts: number; highSeverityAlerts: number }>> {
  const evidence = securityFeatureEvidence(
    repository,
    "codeScanning",
    collectedAt,
  );
  const result = await endpoint(() =>
    octokitPaginate(
      client,
      "GET /repos/{owner}/{repo}/code-scanning/alerts",
      repository,
      GitHubCodeScanningAlertSchema,
      paginationOptions(options),
    ),
  );
  if (!result.value) return featureFailure(result.error, evidence);
  const open = result.value.filter(
    (alert: GitHubCodeScanningAlert) => alert.state.toLowerCase() === "open",
  );
  const highSeverityAlerts = open.filter((alert) => {
    const severity =
      alert.rule?.security_severity_level ?? alert.rule?.severity ?? "";
    return (
      severity.toLowerCase() === "high" || severity.toLowerCase() === "critical"
    );
  }).length;
  return featureSuccess<{ openAlerts: number; highSeverityAlerts: number }>(
    { openAlerts: open.length, highSeverityAlerts },
    result.metadata,
    evidence,
  );
}

async function collectDependabot(
  client: GitHubOctokit,
  repository: RepositoryCoordinates,
  options: CollectorOptions,
  collectedAt: string,
): Promise<FeatureResult<{ openAlerts: number; criticalAlerts: number }>> {
  const evidence = securityFeatureEvidence(
    repository,
    "dependabot",
    collectedAt,
  );
  const result = await endpoint(() =>
    octokitPaginate(
      client,
      "GET /repos/{owner}/{repo}/dependabot/alerts",
      repository,
      GitHubDependabotAlertSchema,
      paginationOptions(options),
    ),
  );
  if (!result.value) return featureFailure(result.error, evidence);
  const open = result.value.filter(
    (alert: GitHubDependabotAlert) => alert.state.toLowerCase() === "open",
  );
  const criticalAlerts = open.filter(
    (alert) => alert.security_advisory?.severity?.toLowerCase() === "critical",
  ).length;
  return featureSuccess<{ openAlerts: number; criticalAlerts: number }>(
    { openAlerts: open.length, criticalAlerts },
    result.metadata,
    evidence,
  );
}

async function collectSecretScanning(
  client: GitHubOctokit,
  repository: RepositoryCoordinates,
  options: CollectorOptions,
  collectedAt: string,
): Promise<FeatureResult<{ openAlerts: number }>> {
  const evidence = securityFeatureEvidence(
    repository,
    "secretScanning",
    collectedAt,
  );
  const result = await endpoint(() =>
    octokitPaginate(
      client,
      "GET /repos/{owner}/{repo}/secret-scanning/alerts",
      repository,
      GitHubSecretScanningAlertSchema,
      paginationOptions(options),
    ),
  );
  if (!result.value) return featureFailure(result.error, evidence);
  const openAlerts = result.value.filter(
    (alert: GitHubSecretScanningAlert) => alert.state.toLowerCase() === "open",
  ).length;
  return featureSuccess<{ openAlerts: number }>(
    { openAlerts },
    result.metadata,
    evidence,
  );
}

export async function collectSecurityPosture(
  client: GitHubOctokit,
  repository: RepositoryCoordinates,
  options: CollectorOptions = {},
): Promise<SecurityPostureFact> {
  const coordinates = RepositoryCoordinatesSchema.parse(repository);
  const collectedAt = nowIso();
  const limit = concurrencyLimit(options.concurrency, 3);
  const [codeScanning, dependabot, secretScanning] = await Promise.all([
    limit(() => collectCodeScanning(client, coordinates, options, collectedAt)),
    limit(() => collectDependabot(client, coordinates, options, collectedAt)),
    limit(() =>
      collectSecretScanning(client, coordinates, options, collectedAt),
    ),
  ]);
  const features = [codeScanning, dependabot, secretScanning];
  const hasOpenAlerts =
    (codeScanning.value?.openAlerts ?? 0) > 0 ||
    (dependabot.value?.openAlerts ?? 0) > 0 ||
    (secretScanning.value?.openAlerts ?? 0) > 0;
  const allAvailable = features.every(
    (feature) => feature.status === "available",
  );
  const overallStatus: SecurityPostureFact["overallStatus"] = hasOpenAlerts
    ? "needs-attention"
    : allAvailable
      ? "healthy"
      : "unknown";
  return {
    codeScanning,
    dependabot,
    secretScanning,
    overallStatus,
    evidence: features.flatMap((feature) => feature.evidence),
  };
}

function action(
  id: string,
  priority: ActionPriority,
  title: string,
  rationale: string,
  repository: RepositoryCoordinates,
  source: ActionPlanItem["source"],
  evidence: Evidence[],
): ActionPlanItem {
  return { id, priority, title, rationale, repository, source, evidence };
}

export function buildActionPlan(
  repository: RepositoryFact,
  branchRisk: BranchRiskFact,
  deliveryHygiene: DeliveryHygieneFact,
  securityPosture: SecurityPostureFact,
): ActionPlanItem[] {
  const actions: ActionPlanItem[] = [];
  const coordinates = repository.coordinates;
  if (repository.archived) {
    actions.push(
      action(
        "archived-repository",
        "low",
        "Decide whether to archive or retire this repository",
        "The repository is already archived; document its ownership and sunset path.",
        coordinates,
        "repo_readiness",
        repository.evidence,
      ),
    );
  }
  if (!repository.license) {
    actions.push(
      action(
        "missing-license",
        "medium",
        "Add an explicit open-source license",
        "A public repository without a license leaves reuse rights unclear.",
        coordinates,
        "repo_readiness",
        repository.evidence,
      ),
    );
  }
  const pullRequestSettings = repository.pullRequestSettings;
  const noncompliantPullRequestSettings = [
    pullRequestSettings.allowMergeCommit === true
      ? "Allow merge commits is enabled"
      : null,
    pullRequestSettings.allowRebaseMerge === true
      ? "Allow rebase merging is enabled"
      : null,
    pullRequestSettings.allowUpdateBranch === false
      ? "Always suggest updating pull request branches is disabled"
      : null,
  ].filter((setting): setting is string => setting !== null);
  if (noncompliantPullRequestSettings.length > 0) {
    actions.push(
      action(
        "configure-pull-request-merging",
        "medium",
        "Align pull request merge settings",
        noncompliantPullRequestSettings.join("; ") + ".",
        coordinates,
        "repo_readiness",
        repository.evidence,
      ),
    );
  }
  if (branchRisk.protectionStatus === "unprotected") {
    actions.push(
      action(
        "protect-default-branch",
        "high",
        "Protect the default branch",
        "Add the smallest guardrails that fit the project, such as blocking accidental force-pushes and deletions.",
        coordinates,
        "branch_risk",
        branchRisk.evidence,
      ),
    );
  } else if (branchRisk.status !== "available") {
    actions.push(
      action(
        "review-branch-protection",
        "medium",
        "Verify default-branch protection",
        branchRisk.reason ??
          "Branch protection could not be confirmed from the available GitHub permissions.",
        coordinates,
        "branch_risk",
        branchRisk.evidence,
      ),
    );
  }
  if (deliveryHygiene.ciStatus === "degraded") {
    const failedRuns = deliveryHygiene.failingWorkflowRuns ?? [];
    const details = failedRuns
      .map(
        (run) =>
          `${run.name ?? "Workflow"} ${run.conclusion ?? "failed"} on ${run.event ?? "unknown event"} at ${run.createdAt ?? "unknown time"}: ${run.url}`,
      )
      .join("; ");
    actions.push(
      action(
        "repair-ci",
        "high",
        "Repair failing automation",
        details || "The latest completed result for a workflow is failing.",
        coordinates,
        "delivery_hygiene",
        deliveryHygiene.evidence,
      ),
    );
  } else if (deliveryHygiene.ciStatus === "unknown") {
    actions.push(
      action(
        "verify-ci",
        "medium",
        "Verify continuous integration coverage",
        deliveryHygiene.reason ?? "Workflow status was not available.",
        coordinates,
        "delivery_hygiene",
        deliveryHygiene.evidence,
      ),
    );
  }
  if (
    (securityPosture.codeScanning.value?.highSeverityAlerts ?? 0) > 0 ||
    (securityPosture.dependabot.value?.criticalAlerts ?? 0) > 0
  ) {
    actions.push(
      action(
        "triage-critical-security",
        "critical",
        "Triage critical security findings",
        "High-severity code scanning or critical dependency findings are open.",
        coordinates,
        "security_posture",
        securityPosture.evidence,
      ),
    );
  } else if (
    (securityPosture.codeScanning.value?.openAlerts ?? 0) > 0 ||
    (securityPosture.dependabot.value?.openAlerts ?? 0) > 0 ||
    (securityPosture.secretScanning.value?.openAlerts ?? 0) > 0
  ) {
    actions.push(
      action(
        "triage-security",
        "high",
        "Triage open security findings",
        "GitHub reports one or more open security alerts.",
        coordinates,
        "security_posture",
        securityPosture.evidence,
      ),
    );
  } else if (securityPosture.overallStatus === "unknown") {
    actions.push(
      action(
        "verify-security",
        "medium",
        "Verify repository security posture",
        "One or more GitHub security features were unavailable or permission-limited.",
        coordinates,
        "security_posture",
        securityPosture.evidence,
      ),
    );
  }
  return actions;
}

export async function collectRepositoryReadiness(
  client: GitHubOctokit,
  repository: RepositoryCoordinates,
  options: CollectorOptions = {},
): Promise<RepositoryReadiness> {
  const coordinates = RepositoryCoordinatesSchema.parse(repository);
  const collectedAt = nowIso();
  const repositoryResponse = await octokitGet(
    client,
    "GET /repos/{owner}/{repo}",
    { ...coordinates, ...requestOptions(options) },
    GitHubRepositorySchema,
  );
  if (repositoryResponse.data.private)
    throw new PrivateRepositoryError(coordinates);
  const fact = repositoryFact(
    coordinates,
    repositoryResponse.data,
    collectedAt,
  );
  const [branchRisk, deliveryHygiene, securityPosture] = await Promise.all([
    collectBranchRisk(client, coordinates, fact.defaultBranch, options),
    collectDeliveryHygiene(client, coordinates, fact.defaultBranch, options),
    collectSecurityPosture(client, coordinates, options),
  ]);
  const actionPlan = buildActionPlan(
    fact,
    branchRisk,
    deliveryHygiene,
    securityPosture,
  );
  const pullRequestSettingsStatus: CollectionStatus = Object.values(
    fact.pullRequestSettings,
  ).every((value) => value !== null)
    ? "available"
    : "unknown";
  const components = [
    branchRisk.status,
    deliveryHygiene.status,
    securityPostureStatus(securityPosture),
    pullRequestSettingsStatus,
  ];
  const hasKnownAttention = actionPlan.some(
    (item) => item.priority === "critical" || item.priority === "high",
  );
  const hasAction = actionPlan.length > 0;
  const status: RepositoryReadiness["status"] = hasKnownAttention
    ? "needs-attention"
    : components.every((value) => value === "available")
      ? hasAction
        ? "needs-attention"
        : "ready"
      : "unknown";
  return {
    repository: fact,
    branchRisk,
    deliveryHygiene,
    securityPosture,
    actionPlan,
    status,
    evidence: [
      ...fact.evidence,
      ...branchRisk.evidence,
      ...deliveryHygiene.evidence,
      ...securityPosture.evidence,
    ],
  };
}

export const collectRepoReadiness = collectRepositoryReadiness;

export async function collectPortfolioSnapshot(
  client: GitHubOctokit,
  owner: string,
  options: PortfolioSnapshotOptions = {},
): Promise<PortfolioSnapshot> {
  const validatedOwner = GitHubOwnerInputSchema.parse(owner);
  const collectedAt = nowIso();
  let repositories: RepositoryCoordinates[];
  let listingEvidence = [
    featureEvidence(
      `https://github.com/${encodeURIComponent(validatedOwner)}?tab=repositories`,
      `${validatedOwner} public repositories`,
      collectedAt,
    ),
  ];
  try {
    if (options.repositories) {
      repositories = options.repositories.map((repository) =>
        RepositoryCoordinatesSchema.parse(repository),
      );
    } else {
      const response = await octokitPaginate(
        client,
        "GET /users/{username}/repos",
        {
          username: validatedOwner,
          type: "owner",
          sort: "updated",
          direction: "desc",
          ...requestOptions(options),
        },
        GitHubRepositorySchema,
        paginationOptions(options),
      );
      repositories = response.data.map((repository) => {
        const [repositoryOwner, repositoryName] =
          repository.full_name.split("/");
        return RepositoryCoordinatesSchema.parse({
          owner: repositoryOwner ?? validatedOwner,
          repo: repositoryName ?? repository.name,
        });
      });
      listingEvidence = [
        ...listingEvidence,
        featureEvidence(
          response.metadata.url,
          "GitHub repository listing API",
          collectedAt,
        ),
      ];
    }
  } catch (error) {
    if (error instanceof PrivateRepositoryError) throw error;
    return {
      owner: validatedOwner,
      repositories: [],
      actionPlan: [],
      totals: {
        repositories: 0,
        needsAttention: 0,
        unknown: 0,
        openSecurityAlerts: null,
      },
      status: "unknown",
      collectedAt,
      evidence: [
        ...listingEvidence,
        featureEvidence(
          errorUrl(error),
          "Repository listing unavailable",
          collectedAt,
        ),
      ],
    };
  }

  const limit = concurrencyLimit(options.concurrency, 3);
  const results = await limit.map(repositories, async (repository) => {
    try {
      return {
        readiness: await collectRepositoryReadiness(
          client,
          repository,
          options,
        ),
        error: null,
      };
    } catch (error) {
      if (error instanceof PrivateRepositoryError) throw error;
      return { readiness: null, error };
    }
  });
  const readiness = results.flatMap((result) =>
    result.readiness ? [result.readiness] : [],
  );
  const failed = results.filter((result) => result.error !== null);
  const actionPlan = readiness.flatMap((item) => item.actionPlan);
  const anyUnknown =
    failed.length > 0 || readiness.some((item) => item.status === "unknown");
  const anyPartial = readiness.some(
    (item) =>
      item.branchRisk.status === "partial" ||
      item.deliveryHygiene.status === "partial" ||
      item.securityPosture.overallStatus === "unknown",
  );
  const openSecurityAlerts = readiness.some((item) =>
    securityFeatureUnavailable(item.securityPosture),
  )
    ? null
    : readiness.reduce(
        (total, item) =>
          total +
          (item.securityPosture.codeScanning.value?.openAlerts ?? 0) +
          (item.securityPosture.dependabot.value?.openAlerts ?? 0) +
          (item.securityPosture.secretScanning.value?.openAlerts ?? 0),
        0,
      );
  const status: CollectionStatus = anyUnknown
    ? "unknown"
    : anyPartial
      ? "partial"
      : "available";
  return {
    owner: validatedOwner,
    repositories: readiness,
    actionPlan,
    totals: {
      repositories: repositories.length,
      needsAttention: readiness.filter(
        (item) => item.status === "needs-attention",
      ).length,
      unknown:
        repositories.length -
        readiness.length +
        readiness.filter((item) => item.status === "unknown").length,
      openSecurityAlerts,
    },
    status,
    collectedAt,
    evidence: [
      ...listingEvidence,
      ...readiness.flatMap((item) => item.evidence),
    ],
  };
}

export const collectPortfolio = collectPortfolioSnapshot;

function requestOptions(options: CollectorOptions): Record<string, unknown> {
  return options.signal ? { request: { signal: options.signal } } : {};
}

function paginationOptions(options: CollectorOptions): {
  maxPages?: number;
  perPage?: number;
} {
  return {
    maxPages: options.maxPages,
    perPage: options.perPage,
  };
}

function securityPostureStatus(posture: SecurityPostureFact): CollectionStatus {
  const features = [
    posture.codeScanning.status,
    posture.dependabot.status,
    posture.secretScanning.status,
  ];
  return features.every((status) => status === "available")
    ? "available"
    : features.every((status) => status === "unknown")
      ? "unknown"
      : "partial";
}

function securityFeatureUnavailable(posture: SecurityPostureFact): boolean {
  return [
    posture.codeScanning,
    posture.dependabot,
    posture.secretScanning,
  ].some((feature) => feature.status !== "available");
}

function errorUrl(error: unknown): string {
  if (error instanceof Error && "response" in error) {
    const response = error.response;
    if (
      response &&
      typeof response === "object" &&
      "url" in response &&
      typeof response.url === "string"
    )
      return response.url;
  }
  return "https://docs.github.com/en/rest";
}

export type { RepoReadinessFact };
