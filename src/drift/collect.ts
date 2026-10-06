import { z } from "zod";
import pLimit from "p-limit";
import {
  GitHubInputError,
  PrivateRepositoryError,
  octokitGet,
  type GitHubOctokit,
} from "../github/client";
import {
  GitHubBranchProtectionSchema,
  GitHubBranchSchema,
  GitHubOwnerInputSchema,
  GitHubRepositorySchema,
  RepositoryCoordinatesSchema,
  type GitHubBranchProtection,
  type GitHubRepository,
  type RepositoryCoordinates,
} from "../github/schemas";
import { BlobSchema, TreeSchema, decode } from "../standards/collect";
import { FilePathSchema } from "../standards/policy";
import {
  REPOSITORY_SETTINGS,
  evaluateRepositoryDrift,
  protectedBranchesFor,
  type BranchProtectionFact,
  type ProtectionState,
  type RepositoryDrift,
  type RepositorySettingId,
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
  client: GitHubOctokit,
  coordinates: RepositoryCoordinates,
  branch: string,
): Promise<BranchProtectionFact> {
  let protectedBranch: boolean | undefined;

  try {
    protectedBranch = (
      await octokitGet(
        client,
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
      await octokitGet(
        client,
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
  client: GitHubOctokit,
  policy: DriftPolicy,
  coordinates: RepositoryCoordinates,
): Promise<RepositoryDrift | null> {
  const repository = (
    await octokitGet(
      client,
      "GET /repos/{owner}/{repo}",
      coordinates,
      GitHubRepositorySchema,
    )
  ).data;

  if (repository.private) throw new PrivateRepositoryError(coordinates);

  const selection = {
    name: repository.name,
    fork: repository.fork,
    archived: repository.archived,
  };

  const branches = new Map<string, BranchProtectionFact>();

  for (const branch of protectedBranchesFor(
    policy,
    selection,
    repository.default_branch,
  ))
    branches.set(branch, await collectBranch(client, coordinates, branch));

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
    topics: repository.topics ?? [],
    branches,
  });
}

export interface DriftOptions {
  readonly page: number;
  readonly perPage: number;
  readonly source: { kind: "inline" } | { kind: "policy"; url: string };
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
  const limit = pLimit(4);

  const results = await Promise.all(
    selected.map((repository) =>
      limit(async () => {
        const coordinates = RepositoryCoordinatesSchema.parse({
          owner: repository.owner?.login ?? validatedOwner,
          repo: repository.name,
        });

        try {
          return await collectRepository(client, policy, coordinates);
        } catch (error) {
          if (error instanceof PrivateRepositoryError) return null;

          return {
            repository: repository.full_name,
            url: repository.html_url,
            error: "The repository settings could not be read.",
          };
        }
      }),
    ),
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
