import { z } from "zod";
import { GitHubInputError } from "../github/client";
import { GitHubRefInputSchema } from "../github/schemas";
import { parseYaml } from "../standards/policy";

/**
 * Repository patterns are globs rather than regular expressions.  They are
 * matched in linear time, so a shared policy cannot stall the Worker with a
 * catastrophically backtracking pattern.
 */
const GlobSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._*?-]+$/u, "Use a repository-name glob with * and ?");

const TopicSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,49}$/u, "Use a lowercase GitHub topic");

const StatusCheckSchema = z.string().trim().min(1).max(255);

export const MergeSettingsSchema = z
  .object({
    allowSquash: z.boolean().optional(),
    allowMergeCommit: z.boolean().optional(),
    allowRebase: z.boolean().optional(),
    allowAutoMerge: z.boolean().optional(),
    allowUpdateBranch: z.boolean().optional(),
    deleteBranchOnMerge: z.boolean().optional(),
  })
  .strict();

export const FeatureSettingsSchema = z
  .object({
    issues: z.boolean().optional(),
    wiki: z.boolean().optional(),
    projects: z.boolean().optional(),
    discussions: z.boolean().optional(),
  })
  .strict();

export const SecuritySettingsSchema = z
  .object({
    secretScanning: z.boolean().optional(),
    pushProtection: z.boolean().optional(),
    dependabotSecurityUpdates: z.boolean().optional(),
    privateVulnerabilityReporting: z.boolean().optional(),
  })
  .strict();

export const RepositoryFileSettingsSchema = z
  .object({
    readme: z.boolean().optional(),
    license: z.boolean().optional(),
    contributing: z.boolean().optional(),
    codeOfConduct: z.boolean().optional(),
    security: z.boolean().optional(),
    citation: z.boolean().optional(),
  })
  .strict();

export const WorkflowSecuritySettingsSchema = z
  .object({
    leastPrivilegeToken: z.boolean().optional(),
    pinnedActions: z.boolean().optional(),
    dependencyReview: z.boolean().optional(),
  })
  .strict();

export const RepositoryRulesSettingsSchema = z
  .object({ activeRuleset: z.boolean().optional() })
  .strict();

export const BranchProtectionSettingsSchema = z
  .object({
    /** Omit to target each repository's current default branch. */
    branch: GitHubRefInputSchema.optional(),
    requiredSignatures: z.boolean().optional(),
    enforceAdmins: z.boolean().optional(),
    requiredLinearHistory: z.boolean().optional(),
    allowForcePushes: z.boolean().optional(),
    allowDeletions: z.boolean().optional(),
    requiredConversationResolution: z.boolean().optional(),
    dismissStaleReviews: z.boolean().optional(),
    requireCodeOwnerReviews: z.boolean().optional(),
    requireLastPushApproval: z.boolean().optional(),
    /** A minimum: stricter repositories still comply. */
    requiredApprovingReviews: z.number().int().min(0).max(6).optional(),
    /** Contexts that must be present; additional required checks comply. */
    requiredStatusChecks: z.array(StatusCheckSchema).max(20).optional(),
  })
  .strict();

export const DriftRuleSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/u, "Use a lowercase kebab-case id"),
    description: z.string().trim().min(1).max(300).optional(),
    repositories: z
      .object({
        include: z.array(GlobSchema).min(1).max(20).default(["*"]),
        exclude: z.array(GlobSchema).max(20).default([]),
        forks: z.boolean().default(false),
        archived: z.boolean().default(false),
      })
      .strict()
      .default({ include: ["*"], exclude: [], forks: false, archived: false }),
    merge: MergeSettingsSchema.optional(),
    features: FeatureSettingsSchema.optional(),
    topics: z
      .object({
        required: z.array(TopicSchema).max(20).default([]),
        forbidden: z.array(TopicSchema).max(20).default([]),
      })
      .strict()
      .optional(),
    security: SecuritySettingsSchema.optional(),
    repositoryFiles: RepositoryFileSettingsSchema.optional(),
    workflowSecurity: WorkflowSecuritySettingsSchema.optional(),
    repositoryRules: RepositoryRulesSettingsSchema.optional(),
    branchProtection: BranchProtectionSettingsSchema.optional(),
  })
  .strict()
  .superRefine((rule, context) => {
    const declared = [
      rule.merge,
      rule.features,
      rule.security,
      rule.repositoryFiles,
      rule.workflowSecurity,
      rule.repositoryRules,
      rule.branchProtection,
    ].some(
      (section) =>
        section !== undefined &&
        Object.entries(section).some(
          ([key, value]) => key !== "branch" && value !== undefined,
        ),
    );

    const topics =
      (rule.topics?.required.length ?? 0) +
        (rule.topics?.forbidden.length ?? 0) >
      0;

    if (!declared && !topics)
      context.addIssue({
        code: "custom",
        message: `Rule ${rule.id} declares no settings`,
      });

    const forbidden = new Set(rule.topics?.forbidden);

    if (rule.topics?.required.some((topic) => forbidden.has(topic)))
      context.addIssue({
        code: "custom",
        message: `Rule ${rule.id} both requires and forbids a topic`,
      });
  });

export const DriftPolicySchema = z
  .object({
    version: z.literal(1),
    rules: z.array(DriftRuleSchema).min(1).max(25),
  })
  .strict()
  .superRefine((policy, context) => {
    const ids = policy.rules.map((rule) => rule.id);

    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: "custom", message: "Duplicate rule ids" });
  });

export type DriftPolicy = z.infer<typeof DriftPolicySchema>;

export type DriftRule = z.infer<typeof DriftRuleSchema>;

export function parseDriftPolicy(text: string): DriftPolicy {
  try {
    return DriftPolicySchema.parse(parseYaml(text));
  } catch (error) {
    const issue =
      error instanceof z.ZodError ? error.issues[0]?.message : undefined;

    throw new GitHubInputError(
      `Invalid settings policy${issue ? `: ${issue}` : ""}. Use version: 1 and uniquely named rules that each declare at least one setting.`,
    );
  }
}

/** Wildcard matching with `*` and `?`, linear in pattern times name length. */
export function globMatches(pattern: string, name: string): boolean {
  const glob = pattern.toLowerCase();
  const value = name.toLowerCase();
  let p = 0;
  let v = 0;
  let star = -1;
  let resume = 0;

  while (v < value.length) {
    if (p < glob.length && (glob[p] === "?" || glob[p] === value[v])) {
      p += 1;
      v += 1;
    } else if (p < glob.length && glob[p] === "*") {
      star = p;
      resume = v;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      resume += 1;
      v = resume;
    } else return false;
  }

  while (glob[p] === "*") p += 1;

  return p === glob.length;
}

export interface RepositorySelectionFacts {
  readonly name: string;
  readonly fork: boolean;
  readonly archived: boolean;
}

export function ruleSelects(
  rule: DriftRule,
  repository: RepositorySelectionFacts,
): boolean {
  const scope = rule.repositories;

  if (repository.fork && !scope.forks) return false;

  if (repository.archived && !scope.archived) return false;

  return (
    scope.include.some((glob) => globMatches(glob, repository.name)) &&
    !scope.exclude.some((glob) => globMatches(glob, repository.name))
  );
}
