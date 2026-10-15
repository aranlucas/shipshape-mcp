import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppEnv } from "./env";
import type { OverviewResponse, PracticeDetailResponse, RepoDetailResponse } from "./api/contract";
import { GitHubInputError, GitHubPayloadError } from "./github/client";
import { GitHubOwnerInputSchema } from "./github/schemas";
import { buildOverview, buildPracticeDetail, buildRepoDetail } from "./practices/views";
import { listRepositories } from "./practices/store";

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

type PracticePayload = OverviewResponse | RepoDetailResponse | PracticeDetailResponse;

function jsonResult(payload: PracticePayload) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function toolError(cause: unknown) {
  const status = z.object({ status: z.number() }).safeParse(cause).data?.status;
  let message = "The practice could not be read right now.";

  if (cause instanceof GitHubInputError) {
    message = cause.message;
  } else if (cause instanceof Error && status !== undefined) {
    message =
      status === 404
        ? "The repository or requested GitHub feature was not found."
        : status === 403
          ? "GitHub denied this read-only request or the feature is unavailable on the repository's plan."
          : `GitHub returned HTTP ${status} while inspecting the repository.`;
  } else if (cause instanceof GitHubPayloadError) {
    message = "GitHub returned an invalid or incomplete response.";
  } else if (cause instanceof Error) {
    message = cause.message;
  }

  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
  };
}

async function safely(operation: () => Promise<PracticePayload>) {
  try {
    return jsonResult(await operation());
  } catch (error) {
    return toolError(error);
  }
}

const RepoInputSchema = z
  .object({
    owner: GitHubOwnerInputSchema.describe("Repository owner"),
    repo: z.string().min(1).max(100).describe("Repository name"),
  })
  .strict();

export function createPracticesServer(env: AppEnv): McpServer {
  const server = new McpServer({ name: "Shipshape", version: "0.1.0" });

  server.registerTool(
    "practices_overview",
    {
      title: "Practices overview",
      description: "Summarize tracked repositories and practice results.",
      inputSchema: z
        .object({
          owner: GitHubOwnerInputSchema.optional().describe("Filter by repository owner"),
          state: z
            .enum(["pass", "fail", "unknown", "not_applicable"])
            .optional()
            .describe("Keep only cells with this state"),
        })
        .strict(),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    ({ owner, state }) =>
      safely(async () => {
        const overview = await buildOverview(env);
        const ownerKey = owner?.toLowerCase();

        const allowedRepos = overview.repos.filter(
          (repo) => ownerKey === undefined || repo.owner.toLowerCase() === ownerKey,
        );

        const results: typeof overview.results = {};

        for (const repo of allowedRepos) {
          const repoResults = overview.results[repo.fullName] ?? {};

          const filtered = state
            ? Object.fromEntries(
                Object.entries(repoResults).filter(([, cell]) => cell.state === state),
              )
            : repoResults;

          if (Object.keys(filtered).length > 0 || state === undefined) {
            results[repo.fullName] = filtered;
          }
        }

        const repos = state
          ? allowedRepos.filter((repo) => Object.keys(results[repo.fullName] ?? {}).length > 0)
          : allowedRepos;

        return { ...overview, repos, results };
      }),
  );

  server.registerTool(
    "repo_practices",
    {
      title: "Repository practices",
      description: "Show practice results and checks for one tracked repository.",
      inputSchema: RepoInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    ({ owner, repo }) =>
      safely(async () => {
        const repositories = await listRepositories(env.DB);

        const found = repositories.find(
          (candidate) =>
            candidate.owner.toLowerCase() === owner.toLowerCase() &&
            candidate.name.toLowerCase() === repo.toLowerCase(),
        );

        if (!found) {
          throw new Error("Repository not found");
        }

        return buildRepoDetail(env, found);
      }),
  );

  server.registerTool(
    "practice_detail",
    {
      title: "Practice detail",
      description: "Show a practice definition and its result counts.",
      inputSchema: z.object({ id: z.string().min(1).max(64) }).strict(),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    ({ id }) => safely(() => buildPracticeDetail(env, id)),
  );

  return server;
}
