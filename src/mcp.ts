import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";

export { MCP_SCOPE } from "./config";
import {
  evaluateBranchRisk,
  evaluateDeliveryHygiene,
  evaluateRepositoryReadiness,
  evaluateSecurityPosture,
} from "./domain/evaluate";
import {
  buildActionPlan as buildDomainActionPlan,
  categoryRollup,
  scoreChecks,
} from "./domain/scoring";
import type { RuleCategory } from "./domain/types";
import {
  collectBranchRisk,
  collectDeliveryHygiene,
  collectPortfolioSnapshot,
  collectRepositoryReadiness,
} from "./github/collectors";
import {
  GitHubApiError,
  GitHubClient,
  GitHubClientError,
  GitHubInputError,
  PrivateRepositoryError,
} from "./github/client";

const OwnerSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(/^(?!-)[A-Za-z0-9-]+(?<!-)$/u, "Enter a valid GitHub owner");
const RepositorySchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/u, "Enter a valid GitHub repository name");
const RefSchema = z.string().min(1).max(255);
const CoordinatesSchema = z.object({
  owner: OwnerSchema.describe("GitHub user or organization"),
  repo: RepositorySchema.describe("Public GitHub repository name"),
});
const AuthPropsSchema = z.object({
  accessToken: z.string().min(1).max(4_096),
  login: OwnerSchema,
});

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

type ToolPayload = Record<string, unknown>;

function githubClient(): GitHubClient {
  const parsed = AuthPropsSchema.safeParse(getMcpAuthContext()?.props);
  if (!parsed.success)
    throw new GitHubInputError("GitHub authorization is required");
  return new GitHubClient({ token: parsed.data.accessToken });
}

function jsonResult(payload: ToolPayload) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
    structuredContent: payload,
  };
}

function toolError(error: unknown) {
  let message = "The repository could not be inspected right now.";
  if (error instanceof PrivateRepositoryError) {
    message = "Shipshape only inspects public repositories.";
  } else if (error instanceof GitHubInputError) {
    message = error.message;
  } else if (error instanceof GitHubApiError) {
    message =
      error.status === 404
        ? "The public repository or requested GitHub feature was not found."
        : error.status === 403
          ? "GitHub denied this read-only request or the feature is unavailable on the repository's plan."
          : `GitHub returned HTTP ${error.status} while inspecting the repository.`;
  } else if (error instanceof GitHubClientError) {
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

export function createShipshapeServer(): McpServer {
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
        owner: OwnerSchema.describe("GitHub user or organization"),
        limit: z.number().int().min(1).max(8).default(4),
        includeForks: z.boolean().default(false),
        includeArchived: z.boolean().default(false),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ owner, limit, includeForks, includeArchived }) =>
      safely(async () => {
        const client = githubClient();
        const listed = await client.listRepositories(owner, {
          maxPages: 1,
          perPage: 50,
        });
        const repositories = listed.data
          .filter((repository) => !repository.private)
          .filter((repository) => includeForks || !repository.fork)
          .filter((repository) => includeArchived || !repository.archived)
          .slice(0, limit)
          .map((repository) => ({
            owner: repository.full_name.split("/")[0] ?? owner,
            repo: repository.name,
          }));
        const snapshot = await collectPortfolioSnapshot(client, owner, {
          repositories,
          concurrency: Math.min(4, limit),
          maxPages: 1,
          perPage: 20,
        });
        const results = snapshot.repositories.map((readiness) => {
          const checks = evaluateRepositoryReadiness(readiness);
          const plan = buildDomainActionPlan(checks, { maxItems: 3 });
          return {
            repository: readiness.repository.fullName,
            status: readiness.status,
            score: scoreChecks(checks),
            nextActions: plan.items,
          };
        });
        results.sort((left, right) => {
          const leftScore = left.score.score ?? 101;
          const rightScore = right.score.score ?? 101;
          return (
            leftScore - rightScore ||
            left.repository.localeCompare(right.repository)
          );
        });

        return {
          owner,
          status: snapshot.status,
          scannedRepositories: results.length,
          availableRepositories: listed.data.length,
          results,
          collectedAt: snapshot.collectedAt,
        };
      }),
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
          { maxPages: 2, perPage: 25, concurrency: 3 },
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
        branch: RefSchema.describe("Branch name"),
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
        branch: RefSchema.describe("Branch name"),
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
        const readiness = await collectRepositoryReadiness(client, repository, {
          maxPages: 1,
          perPage: 25,
          concurrency: 3,
        });
        const security = readiness.securityPosture;
        const checks = evaluateSecurityPosture(
          security,
          readiness.repository,
          readiness.branchRisk,
        );
        return {
          repository,
          security,
          audit: categoryResult("security_posture", checks),
        };
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
        const readiness = await collectRepositoryReadiness(
          githubClient(),
          { owner, repo },
          { maxPages: 2, perPage: 25, concurrency: 3 },
        );
        const checks = evaluateRepositoryReadiness(readiness);
        return {
          repository: readiness.repository,
          score: scoreChecks(checks),
          plan: buildDomainActionPlan(checks, { maxItems: limit }),
        };
      }),
  );

  return server;
}
