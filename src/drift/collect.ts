import { z } from "zod";
import type { ZodType } from "zod";
import pLimit from "p-limit";
import {
  GitHubInputError,
  MAX_ALLOWED_CONCURRENCY,
  PrivateRepositoryError,
  octokitGet,
  type GitHubReadParameters,
  type GitHubOctokit,
} from "../github/client";
import {
  GitHubBranchProtectionSchema,
  GitHubBranchSchema,
  GitHubOwnerInputSchema,
  GitHubRepositorySchema,
  RepositoryCoordinatesSchema,
  type GitHubResponseMetadata,
  type GitHubBranchProtection,
  type GitHubRepository,
  type RepositoryCoordinates,
} from "../github/schemas";
import { BlobSchema, TreeSchema, decode } from "../standards/collect";
import { FilePathSchema, parseYaml } from "../standards/policy";
import {
  ConfigObjectSchema,
  ConfigValueSchema,
  configObject as object,
  type ConfigDocument,
  type ConfigValue,
} from "../standards/config-value";
import {
  REPOSITORY_FILE_SETTINGS,
  REPOSITORY_SETTINGS,
  evaluateRepositoryDrift,
  protectedBranchesFor,
  type BranchProtectionFact,
  type ProtectionState,
  type RepositoryDrift,
  type RepositoryFileSettingId,
  type RepositoryRuleSettingId,
  type RepositorySettingId,
  type WorkflowSecuritySettingId,
} from "./evaluate";
import {
  parseDriftPolicy,
  ruleSelects,
  type DriftPolicy,
  type RepositorySelectionFacts,
} from "./policy";

export const PolicySourceSchema = RepositoryCoordinatesSchema.extend({
  ref: z
    .string()
    .regex(/^[a-f0-9]{40}$/u, "Pin the policy to a full commit SHA")
    .describe("Full commit SHA of the policy file"),
  path: FilePathSchema.describe("Repository-relative YAML policy path"),
}).strict();

export type PolicySource = z.infer<typeof PolicySourceSchema>;

const errorStatus = (cause: unknown) =>
  z.object({ status: z.number() }).safeParse(cause).data?.status;

function unavailable(cause: unknown): string {
  const status = errorStatus(cause);

  if (status === 403 || status === 404)
    return `Branch protection is only readable by repository administrators (HTTP ${status}).`;

  return status === undefined
    ? "Branch protection could not be read."
    : `GitHub returned HTTP ${status} for branch protection.`;
}

type DriftGet = <T>(
  route: `GET ${string}`,
  parameters: GitHubReadParameters,
  schema: ZodType<T>,
) => Promise<{ data: T; metadata: GitHubResponseMetadata }>;

const REPOSITORY_FILE_PATHS: Record<
  (typeof REPOSITORY_FILE_SETTINGS)[number]["key"],
  readonly string[]
> = {
  readme: [
    ".github/readme",
    ".github/readme.md",
    ".github/readme.markdown",
    ".github/readme.rst",
    ".github/readme.txt",
    "readme",
    "readme.md",
    "readme.markdown",
    "readme.rst",
    "readme.txt",
    "docs/readme",
    "docs/readme.md",
    "docs/readme.markdown",
    "docs/readme.rst",
    "docs/readme.txt",
  ],
  license: [
    "license",
    "license.md",
    "license.txt",
    "license.rst",
    "copying",
    "copying.md",
    "copying.txt",
  ],
  contributing: [
    ".github/contributing",
    ".github/contributing.md",
    ".github/contributing.rst",
    ".github/contributing.txt",
    "contributing",
    "contributing.md",
    "contributing.rst",
    "contributing.txt",
    "docs/contributing",
    "docs/contributing.md",
    "docs/contributing.rst",
    "docs/contributing.txt",
  ],
  codeOfConduct: [
    ".github/code_of_conduct.md",
    "code_of_conduct.md",
    "docs/code_of_conduct.md",
  ],
  security: [".github/security.md", "security.md", "docs/security.md"],
  citation: [
    "citation",
    "citations",
    "citation.cff",
    "citations.cff",
    "citation.bib",
    "citations.bib",
    "citation.md",
    "citations.md",
    "inst/citation",
  ],
};

interface WorkflowInspection {
  readonly parsed: ConfigDocument | null;
  readonly path: string;
}

function workflowUses(
  value: ConfigValue | undefined,
  uses: string[] = [],
): string[] {
  const list = z.array(ConfigValueSchema).safeParse(value).data;

  if (list) {
    for (const item of list) workflowUses(item, uses);

    return uses;
  }

  const record = ConfigObjectSchema.safeParse(value).data;

  if (!record) return uses;

  for (const [key, child] of Object.entries(record)) {
    const use = z.string().safeParse(child).data;

    if (key === "uses" && use) uses.push(use);
    else workflowUses(child, uses);
  }

  return uses;
}

function workflowTriggersPullRequest(workflow: ConfigDocument) {
  const events = workflow.on;
  const eventName = z.literal("pull_request").safeParse(events).success;

  if (eventName) return true;

  const eventList = z.array(z.string()).safeParse(events).data;

  if (eventList) return eventList.includes("pull_request");

  const eventMap = ConfigObjectSchema.safeParse(events).data;

  return eventMap ? Object.hasOwn(eventMap, "pull_request") : false;
}

function permissionBlocksAreMinimal(workflow: ConfigDocument) {
  const jobs = object(workflow.jobs);
  const blocks: ConfigValue[] = [];
  const workflowHasPermissions = Object.hasOwn(workflow, "permissions");

  if (workflowHasPermissions) blocks.push(workflow.permissions);

  const jobPermissions = Object.values(jobs).map((job) => {
    const permissions = object(job);

    return Object.hasOwn(permissions, "permissions")
      ? permissions.permissions
      : undefined;
  });

  if (!workflowHasPermissions) {
    if (
      !jobPermissions.length ||
      jobPermissions.some((item) => item === undefined)
    )
      return false;

    blocks.push(
      ...jobPermissions.filter(
        (item): item is ConfigValue => item !== undefined,
      ),
    );
  } else blocks.push(...jobPermissions.filter((item) => item !== undefined));

  return blocks.every((block) => {
    const allPermissions = z
      .enum(["read-all", "write-all"])
      .safeParse(block).data;

    if (allPermissions) return false;

    const scopes = ConfigObjectSchema.safeParse(block).data;

    return (
      scopes !== undefined &&
      Object.values(scopes).every(
        (permission) => z.enum(["read", "none"]).safeParse(permission).success,
      )
    );
  });
}

function actionUsesArePinned(workflow: ConfigDocument) {
  return workflowUses(workflow).every((use) => {
    if (use.startsWith("./") || use.startsWith("docker://")) return true;

    if (/\.github\/workflows\/[^/]+\.ya?ml@[^@]+$/iu.test(use)) return true;

    const separator = use.lastIndexOf("@");

    return separator >= 0 && /^[a-f0-9]{40}$/iu.test(use.slice(separator + 1));
  });
}

function hasDependencyReview(workflow: ConfigDocument) {
  return (
    workflowTriggersPullRequest(workflow) &&
    workflowUses(workflow).some((use) =>
      /^actions\/dependency-review-action@/iu.test(use),
    )
  );
}

async function collectActiveRuleset(
  get: DriftGet,
  coordinates: RepositoryCoordinates,
): Promise<boolean | null> {
  let page = 1;

  while (true) {
    try {
      const response = await get(
        "GET /repos/{owner}/{repo}/rulesets",
        { ...coordinates, includes_parents: true, per_page: 100, page },
        z.array(z.object({ enforcement: z.string().optional() }).passthrough()),
      );

      if (
        response.data.some(
          (ruleset) =>
            ruleset.enforcement === "enabled" ||
            ruleset.enforcement === "active",
        )
      )
        return true;

      if (!response.metadata.nextUrl) return false;

      page += 1;
    } catch {
      return null;
    }
  }
}

/** Read a YAML policy from a public repository at an immutable commit. */
export async function readPinnedPolicy(
  client: GitHubOctokit,
  source: PolicySource,
): Promise<{ policy: DriftPolicy; url: string }> {
  const coordinates = { owner: source.owner, repo: source.repo };

  const repo = (
    await octokitGet(
      client,
      "GET /repos/{owner}/{repo}",
      coordinates,
      GitHubRepositorySchema,
    )
  ).data;

  if (repo.private) throw new PrivateRepositoryError(coordinates);

  const tree = (
    await octokitGet(
      client,
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
      { ...coordinates, tree_sha: source.ref, recursive: "1" },
      TreeSchema,
    )
  ).data;

  const entry = tree.tree.find(
    (item) =>
      item.path === source.path &&
      item.type === "blob" &&
      item.mode !== "120000",
  );

  if (!entry || (entry.size ?? 0) > 64_000)
    throw new GitHubInputError(
      `Settings policy ${source.path} was not found as a regular file under 64 KB at ${source.ref}.`,
    );

  const blob = (
    await octokitGet(
      client,
      "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
      { ...coordinates, file_sha: entry.sha },
      BlobSchema,
    )
  ).data;

  return {
    policy: parseDriftPolicy(decode(blob.content)),
    url: `https://github.com/${source.owner}/${source.repo}/blob/${source.ref}/${source.path}`,
  };
}

function protectionState(protection: GitHubBranchProtection): ProtectionState {
  const reviews = protection.required_pull_request_reviews;
  const checks = protection.required_status_checks;

  return {
    requiredSignatures: protection.required_signatures ?? null,
    enforceAdmins: protection.enforce_admins?.enabled ?? false,
    requiredLinearHistory: protection.required_linear_history ?? false,
    allowForcePushes: protection.allow_force_pushes ?? false,
    allowDeletions: protection.allow_deletions ?? false,
    requiredConversationResolution:
      protection.required_conversation_resolution ?? false,
    reviews: reviews
      ? {
          dismissStaleReviews: reviews.dismiss_stale_reviews ?? false,
          requireCodeOwnerReviews: reviews.require_code_owner_reviews ?? false,
          requiredApprovingReviews:
            reviews.required_approving_review_count ?? 0,
          requireLastPushApproval: reviews.require_last_push_approval ?? false,
        }
      : null,
    statusChecks: checks
      ? {
          strict: checks.strict ?? false,
          checks: checks.checks?.length
            ? checks.checks.flatMap((check) =>
                check.context
                  ? [{ context: check.context, appId: check.app_id ?? null }]
                  : [],
              )
            : (checks.contexts ?? []).map((context) => ({
                context,
                appId: null,
              })),
        }
      : null,
    restricted:
      protection.restrictions !== null && protection.restrictions !== undefined,
  };
}

async function collectBranch(
  get: DriftGet,
  coordinates: RepositoryCoordinates,
  branch: string,
): Promise<BranchProtectionFact> {
  let protectedBranch: boolean | undefined;

  try {
    protectedBranch = (
      await get(
        "GET /repos/{owner}/{repo}/branches/{branch}",
        { ...coordinates, branch },
        GitHubBranchSchema,
      )
    ).data.protected;
  } catch (error) {
    return {
      status: "unknown",
      reason:
        errorStatus(error) === 404
          ? `Branch ${branch} does not exist.`
          : "The branch could not be read.",
    };
  }

  if (protectedBranch === false) return { status: "unprotected" };

  try {
    const protection = (
      await get(
        "GET /repos/{owner}/{repo}/branches/{branch}/protection",
        { ...coordinates, branch },
        GitHubBranchProtectionSchema,
      )
    ).data;

    return { status: "protected", protection: protectionState(protection) };
  } catch (error) {
    return { status: "unknown", reason: unavailable(error) };
  }
}

function settingValue(
  repository: GitHubRepository,
  definition: (typeof REPOSITORY_SETTINGS)[number],
): boolean | null {
  if (definition.security) {
    const status = repository.security_and_analysis?.[definition.field]?.status;

    return status === "enabled" ? true : status === "disabled" ? false : null;
  }

  return repository[definition.field] ?? null;
}

async function collectRepository(
  get: DriftGet,
  policy: DriftPolicy,
  repository: GitHubRepository,
  coordinates: RepositoryCoordinates,
): Promise<RepositoryDrift | null> {
  const selection = {
    name: repository.name,
    fork: repository.fork,
    archived: repository.archived,
  };

  const rules = policy.rules.filter((rule) => ruleSelects(rule, selection));

  const branchNames = protectedBranchesFor(
    policy,
    selection,
    repository.default_branch,
  );

  const branchFactsTask = Promise.all(
    branchNames.map(
      async (branch) =>
        [branch, await collectBranch(get, coordinates, branch)] as const,
    ),
  );

  const needsFiles = rules.some((rule) => rule.repositoryFiles !== undefined);

  const needsWorkflows = rules.some(
    (rule) => rule.workflowSecurity !== undefined,
  );

  const needsPrivateVulnerabilityReporting = rules.some(
    (rule) => rule.security?.privateVulnerabilityReporting !== undefined,
  );

  const needsActiveRuleset = rules.some(
    (rule) => rule.repositoryRules?.activeRuleset !== undefined,
  );

  const treeTask =
    needsFiles || needsWorkflows
      ? get(
          "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
          {
            ...coordinates,
            tree_sha: repository.default_branch,
            recursive: "1",
          },
          TreeSchema,
        )
          .then((response) => response.data)
          .catch(() => null)
      : Promise.resolve(null);

  const reportingTask = needsPrivateVulnerabilityReporting
    ? get(
        "GET /repos/{owner}/{repo}/private-vulnerability-reporting",
        coordinates,
        z.object({ enabled: z.boolean() }),
      )
        .then((response) => response.data.enabled)
        .catch(() => null)
    : Promise.resolve(null);

  const rulesetTask = needsActiveRuleset
    ? collectActiveRuleset(get, coordinates)
    : Promise.resolve(null);

  const [branchFacts, tree, privateVulnerabilityReporting, activeRuleset] =
    await Promise.all([branchFactsTask, treeTask, reportingTask, rulesetTask]);

  const branches = new Map<string, BranchProtectionFact>();

  for (const [branch, fact] of branchFacts) branches.set(branch, fact);

  const repositoryFiles: Record<RepositoryFileSettingId, boolean | null> = {
    "repositoryFiles.readme": null,
    "repositoryFiles.license": null,
    "repositoryFiles.contributing": null,
    "repositoryFiles.codeOfConduct": null,
    "repositoryFiles.security": null,
    "repositoryFiles.citation": null,
  };

  const workflowSecurity: Record<WorkflowSecuritySettingId, boolean | null> = {
    "workflowSecurity.leastPrivilegeToken": null,
    "workflowSecurity.pinnedActions": null,
    "workflowSecurity.dependencyReview": null,
  };

  const repositoryRules: Record<RepositoryRuleSettingId, boolean | null> = {
    "repositoryRules.activeRuleset": activeRuleset,
  };

  if (tree) {
    const paths = tree.tree
      .filter((entry) => entry.type === "blob" && entry.mode !== "120000")
      .map((entry) => entry.path.toLowerCase());

    for (const definition of REPOSITORY_FILE_SETTINGS) {
      if (
        !rules.some(
          (rule) => rule.repositoryFiles?.[definition.key] !== undefined,
        )
      )
        continue;

      const present = REPOSITORY_FILE_PATHS[definition.key].some((candidate) =>
        paths.includes(candidate),
      );

      repositoryFiles[definition.id] = present
        ? true
        : tree.truncated
          ? null
          : false;
    }

    if (needsWorkflows) {
      const workflowEntries = tree.tree.filter(
        (entry) =>
          entry.type === "blob" &&
          entry.mode !== "120000" &&
          /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(entry.path),
      );

      const workflowReads: WorkflowInspection[] = await Promise.all(
        workflowEntries.map(async (entry) => {
          if ((entry.size ?? 0) > 128_000)
            return { path: entry.path, parsed: null };

          try {
            const blob = (
              await get(
                "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
                { ...coordinates, file_sha: entry.sha },
                BlobSchema,
              )
            ).data;

            return {
              path: entry.path,
              parsed:
                ConfigObjectSchema.safeParse(parseYaml(decode(blob.content)))
                  .data ?? null,
            };
          } catch {
            return { path: entry.path, parsed: null };
          }
        }),
      );

      const unknown =
        tree.truncated || workflowReads.some((item) => !item.parsed);

      const parsedWorkflows = workflowReads.flatMap((item) =>
        item.parsed ? [item.parsed] : [],
      );

      const allKnown = (values: boolean[]) =>
        values.includes(false) ? false : unknown ? null : true;

      if (
        rules.some(
          (rule) => rule.workflowSecurity?.leastPrivilegeToken !== undefined,
        )
      )
        workflowSecurity["workflowSecurity.leastPrivilegeToken"] = allKnown(
          parsedWorkflows.map(permissionBlocksAreMinimal),
        );

      if (
        rules.some((rule) => rule.workflowSecurity?.pinnedActions !== undefined)
      )
        workflowSecurity["workflowSecurity.pinnedActions"] = allKnown(
          parsedWorkflows.map(actionUsesArePinned),
        );

      if (
        rules.some(
          (rule) => rule.workflowSecurity?.dependencyReview !== undefined,
        )
      ) {
        const found = parsedWorkflows.some(hasDependencyReview);

        workflowSecurity["workflowSecurity.dependencyReview"] = found
          ? true
          : unknown
            ? null
            : false;
      }
    }
  }

  // SAFETY: fromEntries receives exactly one entry per REPOSITORY_SETTINGS id.
  const settings = Object.fromEntries(
    REPOSITORY_SETTINGS.map((definition) => [
      definition.id,
      settingValue(repository, definition),
    ]),
  ) as Record<RepositorySettingId, boolean | null>;

  return evaluateRepositoryDrift(policy, {
    owner: coordinates.owner,
    repo: coordinates.repo,
    fullName: repository.full_name,
    url: repository.html_url,
    defaultBranch: repository.default_branch,
    fork: repository.fork,
    archived: repository.archived,
    settings,
    repositoryFiles,
    workflowSecurity,
    repositoryRules,
    privateVulnerabilityReporting,
    topics: repository.topics ?? [],
    branches,
  });
}

export interface DriftOptions {
  readonly page: number;
  readonly perPage: number;
  readonly source: { kind: "inline" } | { kind: "policy"; url: string };
  readonly onProgress?: (progress: {
    completed: number;
    total: number;
    result:
      | RepositoryDrift
      | { repository: string; url: string; error: string }
      | null;
  }) => void;
}

export async function collectSettingsDrift(
  client: GitHubOctokit,
  owner: string,
  policy: DriftPolicy,
  options: DriftOptions,
) {
  const validatedOwner = GitHubOwnerInputSchema.parse(owner);
  const collectedAt = new Date().toISOString();

  const listing = await octokitGet(
    client,
    "GET /users/{username}/repos",
    {
      username: validatedOwner,
      type: "owner",
      sort: "full_name",
      direction: "asc",
      page: options.page,
      per_page: options.perPage,
    },
    GitHubRepositorySchema.array(),
  );

  const matched = listing.data.filter((repository) => {
    const facts: RepositorySelectionFacts = repository;

    return (
      !repository.private &&
      policy.rules.some((rule) => ruleSelects(rule, facts))
    );
  });

  const selected = matched;
  const requestLimit = pLimit(MAX_ALLOWED_CONCURRENCY);

  const get: DriftGet = (route, parameters, schema) =>
    requestLimit(() => octokitGet(client, route, parameters, schema));

  let completed = 0;

  const results = await Promise.all(
    selected.map(async (repository) => {
      let result:
        | RepositoryDrift
        | { repository: string; url: string; error: string }
        | null = null;

      try {
        const coordinates = RepositoryCoordinatesSchema.parse({
          owner: repository.owner?.login ?? validatedOwner,
          repo: repository.name,
        });

        result = await collectRepository(get, policy, repository, coordinates);
      } catch (error) {
        if (!(error instanceof PrivateRepositoryError))
          result = {
            repository: repository.full_name,
            url: repository.html_url,
            error: "The repository settings could not be read.",
          };
      }

      completed += 1;

      try {
        options.onProgress?.({ completed, total: selected.length, result });
      } catch {
        /* Progress observers must not interrupt a read-only scan. */
      }

      return result;
    }),
  );

  const repositories = results.flatMap((result) =>
    result && "checks" in result ? [result] : [],
  );

  const failures = results.flatMap((result) =>
    result && "error" in result ? [result] : [],
  );

  const status = repositories.some((item) => item.status === "drifted")
    ? "drifted"
    : failures.length ||
        repositories.some((item) => item.status === "unknown") ||
        listing.metadata.nextUrl
      ? "unknown"
      : "compliant";

  return {
    owner: validatedOwner,
    status,
    policy: {
      ...options.source,
      rules: policy.rules.map((rule) => ({
        id: rule.id,
        description: rule.description ?? null,
      })),
    },
    scope: {
      listedRepositories: listing.data.length,
      listingComplete: listing.metadata.nextUrl === null,
      page: options.page,
      pageSize: options.perPage,
      hasNextPage: listing.metadata.nextUrl !== null,
      matchedRepositories: matched.length,
      scannedRepositories: selected.length,
    },
    totals: {
      compliant: repositories.filter((item) => item.status === "compliant")
        .length,
      drifted: repositories.filter((item) => item.status === "drifted").length,
      unknown:
        repositories.filter((item) => item.status === "unknown").length +
        failures.length,
      remediationSteps: repositories.reduce(
        (total, item) => total + item.remediation.length,
        0,
      ),
    },
    repositories,
    failures,
    notice:
      "Shipshape is read-only and never applies remediation. Review each gh api command, then run it with a token that has administration access to the repository.",
    collectedAt,
  };
}
