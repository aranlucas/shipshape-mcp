import { z } from "zod";
import { octokitGet, PrivateRepositoryError, type GitHubOctokit } from "../github/client";
import {
  GitHubOwnerInputSchema,
  GitHubRepositorySchema,
  RepositoryCoordinatesSchema,
  type GitHubRepository,
  type RepositoryCoordinates,
} from "../github/schemas";
import { collectStandardsSource } from "../standards/collect";
import { evaluateReviewStandards } from "./standards";
import { collectPullRequestReview } from "./pull-requests";
import type { RepositoryReview, ReviewFinding } from "./types";

export const REVIEW_PAGE_SIZE = 20;

export async function listReviewRepositories(client: GitHubOctokit, owner: string, page: number) {
  const username = GitHubOwnerInputSchema.parse(owner);
  const currentPage = z.number().int().min(1).max(10_000).parse(page);

  const listing = await octokitGet(
    client,
    "GET /users/{username}/repos",
    {
      username,
      type: "owner",
      sort: "full_name",
      direction: "asc",
      page: currentPage,
      per_page: REVIEW_PAGE_SIZE,
    },
    GitHubRepositorySchema.array(),
  );

  return {
    owner: username,
    page: currentPage,
    hasNextPage: listing.metadata.nextUrl !== null,
    collectedAt: new Date().toISOString(),
    repositories: listing.data
      .filter(
        (repo) =>
          !repo.private &&
          (repo.visibility === undefined ||
            repo.visibility === null ||
            repo.visibility === "public"),
      )
      .map((repo) => ({
        owner: username,
        name: repo.name,
        repository: repo.full_name,
        url: `https://github.com/${username}/${encodeURIComponent(repo.name)}`,
        fork: repo.fork,
        archived: repo.archived,
        state: "not_checked" as const,
      })),
    limitations: [
      "Public repositories only. Listing a repository does not inspect it. Private repositories are outside this connection's scope.",
    ],
  };
}

function healthFindings(repo: GitHubRepository, collectedAt: string): ReviewFinding[] {
  const repository = repo.full_name;

  const evidence = [
    {
      url: `https://github.com/${repository}`,
      label: "Repository metadata",
      detail: `Observed ${collectedAt}`,
    },
  ];

  const pushedAt = repo.pushed_at;
  const age = pushedAt ? (Date.parse(collectedAt) - Date.parse(pushedAt)) / 86_400_000 : null;

  return [
    {
      id: "health.activity",
      repository,
      category: "health",
      title: "Repository purpose and activity",
      state:
        age !== null && Number.isFinite(age)
          ? age > 180
            ? "needs_review"
            : "observed"
          : "unknown",
      priority: "low",
      confidence: "medium",
      current: pushedAt
        ? `Last push reported by GitHub: ${pushedAt}. ${repo.description ?? "No repository description is set."}`
        : "GitHub did not report a last-push time.",
      desired:
        "Keep a clear purpose and owner for maintained repositories; review dormant repositories in context.",
      nextStep:
        "Check ongoing use, consumers, releases and open commitments before deciding to maintain, consolidate or archive. Age alone is not evidence that a repository is unused.",
      evidence,
      approvalRequired: true,
    },
    {
      id: "health.consolidation",
      repository,
      category: "health",
      title: "Consolidation assessment",
      state: "unknown",
      priority: "low",
      confidence: "low",
      current:
        "Cross-repository ownership, consumers and runtime responsibilities have not been compared.",
      desired:
        "Consolidate only when responsibilities overlap and compatibility and ownership are understood.",
      nextStep:
        "Compare a specific repository pair's public APIs, consumers, release cadence and operational responsibilities before proposing a move.",
      evidence,
      approvalRequired: true,
    },
  ];
}

function unavailable(repository: string, category: "standards" | "pull_requests"): ReviewFinding {
  return {
    id: `${category}.unavailable`,
    repository,
    category,
    title:
      category === "standards"
        ? "Standards evidence unavailable"
        : "Pull request evidence unavailable",
    state: "unknown",
    priority: "medium",
    confidence: "low",
    current:
      "The bounded GitHub read could not be completed. This may reflect a missing resource, unavailable endpoint, invalid configuration or provider limit; the cause is unverified.",
    desired: "Collect current evidence before proposing changes.",
    nextStep: "Retry the repository review and inspect the linked repository if this persists.",
    evidence: [{ url: `https://github.com/${repository}`, label: "Repository" }],
    approvalRequired: false,
  };
}

export async function collectRepositoryReview(
  client: GitHubOctokit,
  input: RepositoryCoordinates,
): Promise<RepositoryReview> {
  const coordinates = RepositoryCoordinatesSchema.parse(input);

  const repo = (
    await octokitGet(client, "GET /repos/{owner}/{repo}", coordinates, GitHubRepositorySchema)
  ).data;

  if (
    repo.private ||
    (repo.visibility !== undefined && repo.visibility !== null && repo.visibility !== "public")
  ) {
    throw new PrivateRepositoryError(coordinates);
  }

  const collectedAt = new Date().toISOString();
  const url = `https://github.com/${coordinates.owner}/${encodeURIComponent(coordinates.repo)}`;

  if (repo.fork || repo.archived) {
    return {
      repository: repo.full_name,
      url,
      commit: null,
      collectedAt,
      findings: [
        {
          id: "health.exempt",
          repository: repo.full_name,
          category: "health",
          title: "Repository excluded from convergence",
          state: "not_applicable",
          priority: "low",
          confidence: "high",
          current: repo.fork
            ? "GitHub marks this repository as a fork."
            : "GitHub marks this repository as archived.",
          desired: "Preserve intentional upstream and archived snapshots.",
          nextStep: "No convergence or cleanup change is proposed.",
          evidence: [{ url, label: "Repository metadata" }],
          approvalRequired: false,
        },
      ],
      limitations: [
        "Forks and archived repositories are excluded; no source or pull request checks were requested.",
      ],
    };
  }

  const findings = healthFindings(repo, collectedAt);

  const limitations = [
    "Read-only review. Proposed repository changes require your approval and are not executed here.",
    "Static observations do not prove runtime behavior, meaningful test coverage, dependency compatibility or dead code.",
    "Source inspection is pinned to the displayed default-branch commit; PR checks are pinned to each observed head SHA. Refresh before acting.",
  ];

  let commit: string | null = null;

  try {
    const source = await collectStandardsSource(client, coordinates);
    commit = source.commit;
    findings.push(...evaluateReviewStandards(source));

    if (!source.complete) {
      limitations.push("The source tree is incomplete; missing paths cannot be treated as absent.");
    }
  } catch {
    findings.push(unavailable(repo.full_name, "standards"));
  }

  for (const category of ["dependencies", "cleanup"] as const) {
    if (!findings.some((finding) => finding.category === category)) {
      findings.push({
        id: `${category}.not-inspected`,
        repository: repo.full_name,
        category,
        title:
          category === "dependencies"
            ? "Dependency review not assessed"
            : "Cleanup review not assessed",
        state: "unknown",
        priority: "low",
        confidence: "low",
        current:
          "No review evidence was produced for this category by the bounded Node-package inspection. Other ecosystems and unavailable source remain unassessed.",
        desired: "Collect ecosystem-appropriate evidence before proposing changes.",
        nextStep:
          "Inspect the repository's manifests and entrypoints with the appropriate tooling; do not infer compatibility or unused code from missing findings.",
        evidence: [{ url, label: "Repository" }],
        approvalRequired: true,
      });
    }
  }

  try {
    const pullRequests = await collectPullRequestReview(client, coordinates);
    findings.push(...pullRequests.findings);
    limitations.push(...pullRequests.limitations);
  } catch {
    findings.push(unavailable(repo.full_name, "pull_requests"));
  }

  return { repository: repo.full_name, url, commit, collectedAt, findings, limitations };
}
