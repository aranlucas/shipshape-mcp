import { z } from "zod";

/** The API version used by every request made by the GitHub client. */
export const GitHubOwnerInputSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(/^(?!-)[A-Za-z0-9-]+(?<!-)$/u, "Enter a valid GitHub owner");

export const GitHubRepositoryNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, "Enter a valid repository name")
  .refine((value) => value !== "." && value !== "..", {
    message: "Enter a valid repository name",
  });

export const GitHubRefInputSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (ref) =>
      !/[\u0000-\u0020\u007f~^:?*[\\]/u.test(ref) &&
      !ref.includes("..") &&
      !ref.includes("@{") &&
      !ref.startsWith("/") &&
      !ref.endsWith("/") &&
      !ref.startsWith(".") &&
      !ref.endsWith(".") &&
      !ref.endsWith(".lock") &&
      !ref.includes("//") &&
      ref.split("/").every((part) => part && !part.startsWith(".")),
    { message: "Enter a valid Git ref" },
  );

export const RepositoryCoordinatesSchema = z.object({
  owner: GitHubOwnerInputSchema,
  repo: GitHubRepositoryNameSchema,
});

export const GitHubOwnerSchema = z
  .object({
    login: z.string(),
    html_url: z.string().url().optional(),
  })
  .passthrough();

export const GitHubLicenseSchema = z
  .object({
    key: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    spdx_id: z.string().nullable().optional(),
    url: z.string().url().nullable().optional(),
  })
  .passthrough();

export const GitHubSecurityAnalysisSchema = z
  .object({
    advanced_security: z
      .object({ status: z.string().optional() })
      .nullable()
      .optional(),
    secret_scanning: z
      .object({ status: z.string().optional() })
      .nullable()
      .optional(),
    secret_scanning_push_protection: z
      .object({ status: z.string().optional() })
      .nullable()
      .optional(),
  })
  .passthrough();

/** The subset of a repository response needed for portfolio analysis. */
export const GitHubRepositorySchema = z
  .object({
    id: z.number(),
    name: z.string(),
    full_name: z.string(),
    private: z.boolean(),
    visibility: z.string().nullable().optional(),
    html_url: z.string().url(),
    url: z.string().url().optional(),
    description: z.string().nullable().optional(),
    default_branch: z.string(),
    archived: z.boolean(),
    fork: z.boolean(),
    disabled: z.boolean().optional(),
    created_at: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
    pushed_at: z.string().nullable().optional(),
    language: z.string().nullable().optional(),
    license: GitHubLicenseSchema.nullable().optional(),
    topics: z.array(z.string()).optional(),
    stargazers_count: z.number().optional(),
    watchers_count: z.number().optional(),
    forks_count: z.number().optional(),
    open_issues_count: z.number().optional(),
    size: z.number().optional(),
    has_issues: z.boolean().optional(),
    has_projects: z.boolean().optional(),
    has_wiki: z.boolean().optional(),
    has_pages: z.boolean().optional(),
    has_discussions: z.boolean().optional(),
    allow_merge_commit: z.boolean().optional(),
    allow_rebase_merge: z.boolean().optional(),
    allow_update_branch: z.boolean().optional(),
    security_and_analysis: GitHubSecurityAnalysisSchema.nullable().optional(),
    owner: GitHubOwnerSchema.optional(),
  })
  .passthrough();

export const GitHubBranchCommitSchema = z
  .object({
    sha: z.string(),
    url: z.string().url().optional(),
  })
  .passthrough();

export const GitHubBranchSchema = z
  .object({
    name: z.string(),
    protected: z.boolean().optional(),
    commit: GitHubBranchCommitSchema,
    protection_url: z.string().url().nullable().optional(),
    protection: z.unknown().optional(),
  })
  .passthrough();

const GitHubRequiredStatusChecksSchema = z
  .object({
    strict: z.boolean().optional(),
    contexts: z.array(z.string()).optional(),
    checks: z
      .array(
        z
          .object({
            context: z.string().optional(),
            app_id: z.number().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .nullable()
  .optional();

export const GitHubBranchProtectionSchema = z
  .object({
    url: z.string().url().optional(),
    required_status_checks: GitHubRequiredStatusChecksSchema,
    enforce_admins: z
      .object({ enabled: z.boolean().optional() })
      .nullable()
      .optional(),
    required_pull_request_reviews: z
      .object({
        dismiss_stale_reviews: z.boolean().optional(),
        require_code_owner_reviews: z.boolean().optional(),
        required_approving_review_count: z.number().nullable().optional(),
        require_last_push_approval: z.boolean().optional(),
      })
      .nullable()
      .optional(),
    restrictions: z
      .object({
        users: z.array(z.unknown()).optional(),
        teams: z.array(z.unknown()).optional(),
        apps: z.array(z.unknown()).optional(),
      })
      .nullable()
      .optional(),
    required_linear_history: z.boolean().optional(),
    allow_force_pushes: z.boolean().optional(),
    allow_deletions: z.boolean().optional(),
    required_conversation_resolution: z.boolean().optional(),
    lock_branch: z.boolean().optional(),
  })
  .passthrough();

export const GitHubCommitSchema = z
  .object({
    sha: z.string(),
    html_url: z.string().url(),
    commit: z
      .object({
        message: z.string(),
        author: z
          .object({ date: z.string().nullable().optional() })
          .nullable()
          .optional(),
        committer: z
          .object({ date: z.string().nullable().optional() })
          .nullable()
          .optional(),
      })
      .passthrough(),
    author: z.unknown().nullable().optional(),
    committer: z.unknown().nullable().optional(),
  })
  .passthrough();

export const GitHubPullRequestSchema = z
  .object({
    number: z.number(),
    title: z.string(),
    state: z.enum(["open", "closed"]),
    draft: z.boolean().nullable().optional(),
    html_url: z.string().url(),
    created_at: z.string(),
    updated_at: z.string(),
    closed_at: z.string().nullable().optional(),
    merged_at: z.string().nullable().optional(),
    user: GitHubOwnerSchema.nullable().optional(),
    head: z
      .object({ ref: z.string().optional(), sha: z.string().optional() })
      .passthrough()
      .optional(),
    base: z
      .object({ ref: z.string().optional(), sha: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const GitHubWorkflowRunSchema = z
  .object({
    id: z.number(),
    name: z.string().nullable().optional(),
    display_title: z.string().nullable().optional(),
    run_number: z.number().optional(),
    status: z.string().nullable().optional(),
    conclusion: z.string().nullable().optional(),
    event: z.string().nullable().optional(),
    head_branch: z.string().nullable().optional(),
    head_sha: z.string().nullable().optional(),
    workflow_id: z.number().optional(),
    created_at: z.string(),
    updated_at: z.string(),
    html_url: z.string().url(),
  })
  .passthrough();

export const GitHubCodeScanningAlertSchema = z
  .object({
    number: z.number(),
    state: z.string(),
    created_at: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
    dismissed_by: z.unknown().nullable().optional(),
    dismissed_at: z.string().nullable().optional(),
    rule: z
      .object({
        id: z.string().optional(),
        name: z.string().optional(),
        severity: z.string().nullable().optional(),
        security_severity_level: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    tool: z
      .object({
        name: z.string().optional(),
        version: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    most_recent_instance: z
      .object({
        ref: z.string().optional(),
        state: z.string().optional(),
        commit_sha: z.string().optional(),
        location: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
    html_url: z.string().url().optional(),
  })
  .passthrough();

export const GitHubDependabotAlertSchema = z
  .object({
    number: z.number(),
    state: z.string(),
    dependency: z
      .object({
        package: z
          .object({
            ecosystem: z.string().optional(),
            name: z.string().optional(),
          })
          .passthrough()
          .optional(),
        manifest_path: z.string().optional(),
        scope: z.string().optional(),
      })
      .passthrough()
      .optional(),
    security_advisory: z
      .object({
        ghsa_id: z.string().optional(),
        cve_id: z.string().nullable().optional(),
        summary: z.string().optional(),
        severity: z.string().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    security_vulnerability: z
      .object({
        package: z
          .object({
            ecosystem: z.string().optional(),
            name: z.string().optional(),
          })
          .passthrough()
          .optional(),
        vulnerable_version_range: z.string().optional(),
        first_patched_version: z
          .object({ identifier: z.string().optional() })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    created_at: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
    dismissed_at: z.string().nullable().optional(),
    html_url: z.string().url().optional(),
  })
  .passthrough();

export const GitHubSecretScanningAlertSchema = z
  .object({
    number: z.number(),
    state: z.string(),
    secret_type: z.string().nullable().optional(),
    secret_type_display_name: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
    resolved_at: z.string().nullable().optional(),
    resolution: z.string().nullable().optional(),
    html_url: z.string().url().optional(),
  })
  .passthrough();

export type RepositoryCoordinates = z.infer<typeof RepositoryCoordinatesSchema>;

export type CollectionStatus = "available" | "partial" | "unknown";

export type ActionPriority = "critical" | "high" | "medium" | "low";

export interface RateLimitMetadata {
  limit: number | null;
  remaining: number | null;
  used: number | null;
  resetAt: number | null;
  retryAfterSeconds: number | null;
}

export interface GitHubResponseMetadata {
  url: string;
  status: number;
  etag: string | null;
  notModified: boolean;
  requestId: string | null;
  rateLimit: RateLimitMetadata;
  nextUrl: string | null;
  previousUrl: string | null;
}

export interface Evidence {
  url: string;
  label: string;
  collectedAt: string;
}

export interface FeatureResult<T> {
  status: CollectionStatus;
  value: T | null;
  reason: string | null;
  evidence: Evidence[];
  metadata: GitHubResponseMetadata | null;
}

export interface RepositoryFact {
  coordinates: RepositoryCoordinates;
  fullName: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  visibility: string;
  archived: boolean;
  fork: boolean;
  language: string | null;
  license: string | null;
  topics: string[];
  stars: number | null;
  forks: number | null;
  openIssues: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  pushedAt: string | null;
  pullRequestSettings: {
    allowMergeCommit: boolean | null;
    allowRebaseMerge: boolean | null;
    allowUpdateBranch: boolean | null;
  };
  securitySettings: {
    advancedSecurity: string | null;
    secretScanning: string | null;
    pushProtection: string | null;
  };
  evidence: Evidence[];
}

export interface BranchRiskFact {
  branch: string;
  protected: boolean | null;
  protectionStatus: "protected" | "unprotected" | "unknown";
  requiresPullRequestReviews: boolean | null;
  requiredApprovingReviews: number | null;
  requiredStatusChecks: number | null;
  enforceAdmins: boolean | null;
  allowsForcePushes: boolean | null;
  allowsDeletions: boolean | null;
  status: CollectionStatus;
  reason: string | null;
  evidence: Evidence[];
}

export interface DeliveryHygieneFact {
  recentCommits: number | null;
  latestCommitAt: string | null;
  openPullRequests: number | null;
  draftPullRequests: number | null;
  workflowRuns: number | null;
  successfulWorkflowRuns: number | null;
  failedWorkflowRuns: number | null;
  cancelledWorkflowRuns: number | null;
  inProgressWorkflowRuns: number | null;
  latestWorkflowRun: WorkflowRunSummary | null;
  failingWorkflowRuns: WorkflowRunSummary[] | null;
  ciStatus: "healthy" | "degraded" | "unknown";
  status: CollectionStatus;
  reason: string | null;
  evidence: Evidence[];
}

export interface WorkflowRunSummary {
  id: number;
  name: string | null;
  event: string | null;
  headBranch: string | null;
  headSha: string | null;
  status: string | null;
  conclusion: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  url: string;
}

export interface SecurityPostureFact {
  codeScanning: FeatureResult<{
    openAlerts: number;
    highSeverityAlerts: number;
  }>;
  dependabot: FeatureResult<{ openAlerts: number; criticalAlerts: number }>;
  secretScanning: FeatureResult<{ openAlerts: number }>;
  overallStatus: "healthy" | "needs-attention" | "unknown";
  evidence: Evidence[];
}

export interface ActionPlanItem {
  id: string;
  priority: ActionPriority;
  title: string;
  rationale: string;
  repository: RepositoryCoordinates;
  source:
    | "portfolio_snapshot"
    | "repo_readiness"
    | "branch_risk"
    | "delivery_hygiene"
    | "security_posture";
  evidence: Evidence[];
}

export interface RepositoryReadiness {
  repository: RepositoryFact;
  branchRisk: BranchRiskFact;
  deliveryHygiene: DeliveryHygieneFact;
  securityPosture: SecurityPostureFact;
  actionPlan: ActionPlanItem[];
  status: "ready" | "needs-attention" | "unknown";
  evidence: Evidence[];
}

export interface PortfolioSnapshot {
  owner: string;
  repositories: RepositoryReadiness[];
  actionPlan: ActionPlanItem[];
  totals: {
    repositories: number;
    needsAttention: number;
    unknown: number;
    openSecurityAlerts: number | null;
  };
  status: CollectionStatus;
  collectedAt: string;
  evidence: Evidence[];
}

export type PortfolioSnapshotFact = PortfolioSnapshot;

export type RepoReadinessFact = RepositoryReadiness;

export type ActionPlan = ActionPlanItem[];

export type GitHubRepository = z.infer<typeof GitHubRepositorySchema>;
export type GitHubBranch = z.infer<typeof GitHubBranchSchema>;
export type GitHubBranchProtection = z.infer<
  typeof GitHubBranchProtectionSchema
>;
export type GitHubCommit = z.infer<typeof GitHubCommitSchema>;
export type GitHubPullRequest = z.infer<typeof GitHubPullRequestSchema>;
export type GitHubWorkflowRun = z.infer<typeof GitHubWorkflowRunSchema>;
export type GitHubCodeScanningAlert = z.infer<
  typeof GitHubCodeScanningAlertSchema
>;
export type GitHubDependabotAlert = z.infer<typeof GitHubDependabotAlertSchema>;
export type GitHubSecretScanningAlert = z.infer<
  typeof GitHubSecretScanningAlertSchema
>;
