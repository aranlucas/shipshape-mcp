import { collectPortfolioReport } from "./github/portfolio";
import { collectStandards } from "./standards/collect";
import {
  PolicySourceSchema,
  collectSettingsDrift,
  readPinnedPolicy,
} from "./drift/collect";
import { SETTINGS_DRIFT_PAGE_SIZE } from "./drift/limits";
import { DriftPolicySchema } from "./drift/policy";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  evaluateBranchRisk,
  evaluateDeliveryHygiene,
  evaluateRepositoryReadiness,
  evaluateSecurityPosture,
} from "./domain/evaluate";
import { buildActionPlan, categoryRollup, scoreChecks } from "./domain/scoring";
import type { RuleCategory } from "./domain/types";
import {
  collectBranchRisk,
  collectDeliveryHygiene,
  collectPublicRepository,
  collectRepositoryReadiness,
  collectSecurityPosture,
} from "./github/collectors";
import {
  GitHubInputError,
  GitHubPayloadError,
  PrivateRepositoryError,
  type GitHubOctokit,
} from "./github/client";
import {
  GitHubOwnerInputSchema,
  GitHubRefInputSchema,
  RepositoryCoordinatesSchema,
} from "./github/schemas";

const CoordinatesSchema = RepositoryCoordinatesSchema.extend({
  owner: GitHubOwnerInputSchema.describe("GitHub user or organization"),
  repo: RepositoryCoordinatesSchema.shape.repo.describe(
    "Public GitHub repository name",
  ),
});

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

type ToolPayload = NonNullable<CallToolResult["structuredContent"]>;

function jsonResult(payload: ToolPayload) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
    structuredContent: payload,
  };
}

function toolError(cause: unknown) {
  const error = cause;
  const status = z.object({ status: z.number() }).safeParse(error).data?.status;
  let message = "The repository could not be inspected right now.";

  if (error instanceof PrivateRepositoryError) {
    message = "Shipshape only inspects public repositories.";
  } else if (error instanceof GitHubInputError) {
    message = error.message;
  } else if (error instanceof Error && status !== undefined) {
    message =
      status === 404
        ? "The public repository or requested GitHub feature was not found."
        : status === 403
          ? "GitHub denied this read-only request or the feature is unavailable on the repository's plan."
          : `GitHub returned HTTP ${status} while inspecting the repository.`;
  } else if (error instanceof GitHubPayloadError) {
    message = "GitHub returned an invalid or incomplete response.";
  }

  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

async function safely(operation: () => Promise<ToolPayload>) {
  try {
    return jsonResult(await operation());
  } catch (error) {
    return toolError(error);
  }
}

function categoryResult(
  category: RuleCategory,
  checks: ReturnType<typeof evaluateRepositoryReadiness>,
) {
  return {
    summary: categoryRollup(category, checks),
    checks: checks.filter((check) => check.category === category),
  };
}

export function createPortfolioServer(
  githubClient: () => GitHubOctokit,
): McpServer {
  const server = new McpServer({
    name: "Shipshape",
    version: "0.1.0",
  });

  server.registerTool(
    "portfolio_snapshot",
    {
      title: "Portfolio snapshot",
      description:
        "Rank a bounded set of recently updated public repositories by maintenance need. Deep-scans at most eight repositories.",
      inputSchema: z.object({
        owner: GitHubOwnerInputSchema.describe("GitHub user or organization"),
        limit: z.number().int().min(1).max(8).default(4),
        includeForks: z.boolean().default(false),
        includeArchived: z.boolean().default(false),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ owner, limit, includeForks, includeArchived }) =>
      safely(() =>
        collectPortfolioReport(githubClient(), owner, {
          limit,
          includeForks,
          includeArchived,
        }),
      ),
  );

  server.registerTool(
    "repo_readiness",
    {
      title: "Repository readiness",
      description:
        "Audit a public repository's publication, branch, delivery, and security signals with explicit unknown states.",
      inputSchema: CoordinatesSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (repository) =>
      safely(async () => {
        const readiness = await collectRepositoryReadiness(
          githubClient(),
          repository,
          {
            maxPages: 2,
            perPage: 25,
            concurrency: 3,
          },
        );

        const checks = evaluateRepositoryReadiness(readiness);

        return {
          readiness,
          audit: scoreChecks(checks),
        };
      }),
  );

  server.registerTool(
    "branch_risk",
    {
      title: "Branch controls",
      description:
        "Inspect protection controls for a named branch of a public repository. Unavailable plan- or permission-gated evidence remains unknown.",
      inputSchema: CoordinatesSchema.extend({
        branch: GitHubRefInputSchema.describe("Branch name"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ owner, repo, branch }) =>
      safely(async () => {
        const risk = await collectBranchRisk(
          githubClient(),
          { owner, repo },
          branch,
        );

        const checks = evaluateBranchRisk(risk);

        return {
          repository: { owner, repo },
          risk,
          audit: categoryResult("branch_risk", checks),
        };
      }),
  );

  server.registerTool(
    "delivery_hygiene",
    {
      title: "Delivery hygiene",
      description:
        "Summarize recent commits, open pull requests, and CI health for a public repository branch.",
      inputSchema: CoordinatesSchema.extend({
        branch: GitHubRefInputSchema.describe("Branch name"),
        recentDays: z.number().int().min(1).max(180).default(30),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ owner, repo, branch, recentDays }) =>
      safely(async () => {
        const delivery = await collectDeliveryHygiene(
          githubClient(),
          { owner, repo },
          branch,
          {
            since: new Date(Date.now() - recentDays * 86_400_000).toISOString(),
            maxPages: 2,
            perPage: 25,
            concurrency: 3,
          },
        );

        const checks = evaluateDeliveryHygiene(delivery);

        return {
          repository: { owner, repo },
          branch,
          delivery,
          audit: categoryResult("delivery_hygiene", checks),
        };
      }),
  );

  server.registerTool(
    "security_posture",
    {
      title: "Security posture",
      description:
        "Inspect public GitHub security signals. Permission- and plan-gated endpoints are reported as unknown, never as healthy.",
      inputSchema: CoordinatesSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (repository) =>
      safely(async () => {
        const client = githubClient();
        const fact = await collectPublicRepository(client, repository);
        const options = { maxPages: 1, perPage: 25, concurrency: 3 };

        const [branchRisk, security] = await Promise.all([
          collectBranchRisk(client, repository, fact.defaultBranch, options),
          collectSecurityPosture(client, repository, options),
        ]);

        const checks = evaluateSecurityPosture(security, fact, branchRisk);

        return {
          repository,
          security,
          audit: categoryResult("security_posture", checks),
        };
      }),
  );

  server.registerTool(
    "standards_audit",
    {
      title: "Shared engineering standards",
      description:
        "Audit a public repository against a versioned shared baseline, with Node, Go, and Python package discovery and static configuration evidence. Commands are never executed.",
      inputSchema: CoordinatesSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (repository) =>
      safely(async () => ({
        ...(await collectStandards(githubClient(), repository)),
      })),
  );

  server.registerTool(
    "settings_drift",
    {
      title: "Repository settings drift",
      description:
        "Compare one page of an owner's public repositories with declarative settings rules (merge strategy, features, topics, security analysis, branch protection) selected by repository-name globs. Pass increasing page values until scope.hasNextPage is false to scan every page. Returns per-setting drift and reviewable gh api remediation commands; nothing is ever changed. Supply inline rules or a policy file pinned to a commit.",
      inputSchema: z.object({
        owner: GitHubOwnerInputSchema.describe("GitHub user or organization"),
        rules: DriftPolicySchema.optional().describe(
          "Inline policy: { version: 1, rules: [...] }",
        ),
        policy: PolicySourceSchema.optional().describe(
          "A YAML policy in a public repository, pinned to a full commit SHA",
        ),
        page: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe("One-based page of the owner's GitHub repository listing"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SETTINGS_DRIFT_PAGE_SIZE)
          .default(SETTINGS_DRIFT_PAGE_SIZE)
          .describe("Repositories per page; this does not cap later pages"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ owner, rules, policy, page, limit }) =>
      safely(async () => {
        if ((rules === undefined) === (policy === undefined))
          throw new GitHubInputError("Provide exactly one of rules or policy.");

        const client = githubClient();

        if (rules)
          return collectSettingsDrift(client, owner, rules, {
            page,
            perPage: limit,
            source: { kind: "inline" },
          });

        const pinned = await readPinnedPolicy(client, policy!);

        return collectSettingsDrift(client, owner, pinned.policy, {
          page,
          perPage: limit,
          source: { kind: "policy", url: pinned.url },
        });
      }),
  );

  server.registerTool(
    "action_plan",
    {
      title: "Maintenance action plan",
      description:
        "Return a deterministic, evidence-backed queue of the highest-value maintenance work for one public repository.",
      inputSchema: CoordinatesSchema.extend({
        limit: z.number().int().min(1).max(20).default(8),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ owner, repo, limit }) =>
      safely(async () => {
        const client = githubClient();
        const repository = { owner, repo };

        const [readiness, standards] = await Promise.all([
          collectRepositoryReadiness(client, repository, {
            maxPages: 2,
            perPage: 25,
            concurrency: 3,
          }),
          collectStandards(client, repository),
        ]);

        const checks = [
          ...evaluateRepositoryReadiness(readiness),
          ...standards.audit.checks,
        ];

        return {
          repository: readiness.repository,
          standards,
          score: scoreChecks(checks),
          plan: buildActionPlan(checks, { maxItems: limit }),
        };
      }),
  );

  return server;
}
