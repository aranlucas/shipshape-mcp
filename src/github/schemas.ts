import { hasControlCharacters } from "../control-characters";
import { z } from "zod";

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
      !hasControlCharacters(ref) &&
      !/[ ~^:?*[\\]/u.test(ref) &&
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
    advanced_security: z.object({ status: z.string().optional() }).nullable().optional(),
    secret_scanning: z.object({ status: z.string().optional() }).nullable().optional(),
    secret_scanning_push_protection: z
      .object({ status: z.string().optional() })
      .nullable()
      .optional(),
    dependabot_security_updates: z.object({ status: z.string().optional() }).nullable().optional(),
  })
  .passthrough();

/** The subset of a repository response needed for repository inventory and checks. */
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
    allow_squash_merge: z.boolean().optional(),
    allow_rebase_merge: z.boolean().optional(),
    allow_auto_merge: z.boolean().optional(),
    delete_branch_on_merge: z.boolean().optional(),
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

/** GitHub reports protection toggles as `{ enabled }`; accept bare booleans too. */
const ProtectionFlagSchema = z
  .union([z.boolean(), z.object({ enabled: z.boolean() }).transform((value) => value.enabled)])
  .optional();

export const GitHubBranchProtectionSchema = z
  .object({
    url: z.string().url().optional(),
    required_status_checks: GitHubRequiredStatusChecksSchema,
    enforce_admins: z.object({ enabled: z.boolean().optional() }).nullable().optional(),
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
    required_signatures: ProtectionFlagSchema,
    required_linear_history: ProtectionFlagSchema,
    allow_force_pushes: ProtectionFlagSchema,
    allow_deletions: ProtectionFlagSchema,
    required_conversation_resolution: ProtectionFlagSchema,
    lock_branch: ProtectionFlagSchema,
  })
  .passthrough();

export type RepositoryCoordinates = z.infer<typeof RepositoryCoordinatesSchema>;

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

export type GitHubRepository = z.infer<typeof GitHubRepositorySchema>;

export type GitHubBranch = z.infer<typeof GitHubBranchSchema>;

export type GitHubBranchProtection = z.infer<typeof GitHubBranchProtectionSchema>;
