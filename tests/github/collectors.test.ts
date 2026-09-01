import { describe, expect, it, vi } from "vitest";

import { GitHubClient, PrivateRepositoryError } from "../../src/github/client";
import {
  collectBranchRisk,
  collectDeliveryHygiene,
  collectPortfolioSnapshot,
  collectRepositoryReadiness,
  collectSecurityPosture,
} from "../../src/github/collectors";

const coordinates = { owner: "octo", repo: "demo" } as const;

const repository = {
  id: 42,
  name: "demo",
  full_name: "octo/demo",
  private: false,
  visibility: "public",
  html_url: "https://github.com/octo/demo",
  description: "A public demo",
  default_branch: "main",
  archived: false,
  fork: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-08-30T00:00:00Z",
  pushed_at: "2026-08-29T00:00:00Z",
  language: "TypeScript",
  license: {
    key: "mit",
    name: "MIT License",
    spdx_id: "MIT",
    url: "https://api.github.com/licenses/mit",
  },
  topics: ["demo"],
  stargazers_count: 3,
  watchers_count: 3,
  forks_count: 1,
  open_issues_count: 0,
  has_issues: true,
  has_projects: false,
  has_wiki: false,
  has_pages: false,
  has_discussions: false,
  allow_merge_commit: true,
  allow_rebase_merge: false,
  allow_update_branch: true,
  security_and_analysis: {
    advanced_security: { status: "enabled" },
    secret_scanning: { status: "enabled" },
    secret_scanning_push_protection: { status: "enabled" },
  },
};

const branch = {
  name: "main",
  protected: true,
  commit: {
    sha: "a".repeat(40),
    url: "https://api.github.com/repos/octo/demo/commits/a",
  },
};

const protection = {
  url: "https://api.github.com/repos/octo/demo/branches/main/protection",
  required_status_checks: {
    strict: true,
    contexts: ["verify", "deploy"],
    checks: [
      { context: "verify", app_id: null },
      { context: "deploy", app_id: null },
    ],
  },
  enforce_admins: { enabled: true },
  required_pull_request_reviews: {
    dismiss_stale_reviews: true,
    require_code_owner_reviews: true,
    required_approving_review_count: 1,
  },
  restrictions: null,
  required_linear_history: true,
  allow_force_pushes: false,
  allow_deletions: false,
};

const commit = {
  sha: "b".repeat(40),
  html_url:
    "https://github.com/octo/demo/commit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  commit: {
    message: "ship it",
    author: { date: "2026-08-29T00:00:00Z" },
    committer: { date: "2026-08-29T00:00:00Z" },
  },
};

const pullRequest = {
  number: 1,
  title: "Improve docs",
  state: "open",
  draft: true,
  html_url: "https://github.com/octo/demo/pull/1",
  created_at: "2026-08-28T00:00:00Z",
  updated_at: "2026-08-29T00:00:00Z",
  closed_at: null,
  merged_at: null,
};

const workflowRun = {
  id: 7,
  name: "CI",
  display_title: "CI",
  status: "completed",
  conclusion: "success",
  event: "push",
  head_branch: "main",
  head_sha: "b".repeat(40),
  created_at: "2026-08-29T00:00:00Z",
  updated_at: "2026-08-29T00:01:00Z",
  html_url: "https://github.com/octo/demo/actions/runs/7",
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Route = (url: URL, init?: RequestInit) => Response;

function clientFor(route: Route): { client: GitHubClient; calls: URL[] } {
  const calls: URL[] = [];
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      calls.push(url);
      return route(url, init);
    },
  );
  return {
    client: new GitHubClient({
      token: "token",
      fetch: fetcher as typeof fetch,
    }),
    calls,
  };
}

function fullRoute(url: URL): Response {
  const path = url.pathname;
  if (path === "/repos/octo/demo") return jsonResponse(repository);
  if (path === "/repos/octo/demo/branches/main/protection")
    return jsonResponse(protection);
  if (path === "/repos/octo/demo/branches/main") return jsonResponse(branch);
  if (path === "/repos/octo/demo/commits") return jsonResponse([commit]);
  if (path === "/repos/octo/demo/pulls") return jsonResponse([pullRequest]);
  if (path === "/repos/octo/demo/actions/runs")
    return jsonResponse({ total_count: 1, workflow_runs: [workflowRun] });
  if (path === "/repos/octo/demo/code-scanning/alerts") {
    return jsonResponse([
      {
        number: 1,
        state: "open",
        rule: { security_severity_level: "high" },
        html_url: "https://github.com/octo/demo/security/code-scanning",
      },
    ]);
  }
  if (path === "/repos/octo/demo/dependabot/alerts") {
    return jsonResponse([
      {
        number: 2,
        state: "open",
        security_advisory: { severity: "critical" },
        html_url: "https://github.com/octo/demo/security/dependabot",
      },
    ]);
  }
  if (path === "/repos/octo/demo/secret-scanning/alerts") {
    return jsonResponse([
      {
        number: 3,
        state: "resolved",
        html_url: "https://github.com/octo/demo/security/secret-scanning",
      },
    ]);
  }
  throw new Error(`unhandled route: ${url}`);
}

describe("GitHub collectors", () => {
  it("does not treat cancellations as failures and reports failing run details", async () => {
    const cancelledRun = {
      ...workflowRun,
      id: 9,
      conclusion: "cancelled",
      created_at: "2026-08-30T00:00:00Z",
      html_url: "https://github.com/octo/demo/actions/runs/9",
    };
    const failedRun = {
      ...workflowRun,
      id: 8,
      name: "E2E",
      conclusion: "failure",
      event: "repository_dispatch",
      created_at: "2026-08-29T12:00:00Z",
      html_url: "https://github.com/octo/demo/actions/runs/8",
    };
    const { client } = clientFor((url) => {
      if (url.pathname === "/repos/octo/demo/commits")
        return jsonResponse([commit]);
      if (url.pathname === "/repos/octo/demo/pulls") return jsonResponse([]);
      if (url.pathname === "/repos/octo/demo/actions/runs")
        return jsonResponse({
          total_count: 3,
          workflow_runs: [cancelledRun, failedRun, workflowRun],
        });
      throw new Error(`unhandled route: ${url}`);
    });

    const result = await collectDeliveryHygiene(client, coordinates, "main");

    expect(result).toMatchObject({
      failedWorkflowRuns: 1,
      cancelledWorkflowRuns: 1,
      ciStatus: "degraded",
      latestWorkflowRun: { id: 9, conclusion: "cancelled" },
      failingWorkflowRuns: [
        {
          id: 8,
          name: "E2E",
          conclusion: "failure",
          event: "repository_dispatch",
        },
      ],
    });
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        url: "https://github.com/octo/demo/actions/runs/8",
        label: "E2E failure on repository_dispatch at 2026-08-29T12:00:00Z",
      }),
    );
  });

  it("normalizes repository readiness and produces evidence-backed actions", async () => {
    const { client, calls } = clientFor(fullRoute);

    const result = await collectRepositoryReadiness(client, coordinates, {
      concurrency: 2,
    });

    expect(result.repository.defaultBranch).toBe("main");
    expect(result.repository.pullRequestSettings).toEqual({
      allowMergeCommit: true,
      allowRebaseMerge: false,
      allowUpdateBranch: true,
    });
    expect(result.branchRisk).toMatchObject({
      protectionStatus: "protected",
      requiredStatusChecks: 2,
      requiresPullRequestReviews: true,
    });
    expect(result.deliveryHygiene).toMatchObject({
      recentCommits: 1,
      openPullRequests: 1,
      draftPullRequests: 1,
      ciStatus: "healthy",
      cancelledWorkflowRuns: 0,
      latestWorkflowRun: {
        id: 7,
        name: "CI",
        conclusion: "success",
        event: "push",
      },
      failingWorkflowRuns: [],
    });
    expect(result.securityPosture).toMatchObject({
      overallStatus: "needs-attention",
      codeScanning: { value: { openAlerts: 1, highSeverityAlerts: 1 } },
      dependabot: { value: { openAlerts: 1, criticalAlerts: 1 } },
    });
    expect(result.status).toBe("needs-attention");
    expect(result.actionPlan.map((item) => item.id)).toContain(
      "triage-critical-security",
    );
    expect(result.actionPlan.map((item) => item.id)).toContain(
      "configure-pull-request-merging",
    );
    expect(
      result.evidence.every((item) =>
        item.url.startsWith("https://github.com/"),
      ),
    ).toBe(true);
    expect(calls.every((url) => url.pathname !== "/graphql")).toBe(true);
  });

  it("returns partial and unknown feature states for permission-limited endpoints", async () => {
    const limitedRoute: Route = (url) => {
      if (url.pathname === "/repos/octo/demo") return jsonResponse(repository);
      if (url.pathname === "/repos/octo/demo/branches/main")
        return jsonResponse(branch);
      if (url.pathname === "/repos/octo/demo/branches/main/protection")
        return jsonResponse({ message: "not found" }, 404);
      if (
        url.pathname === "/repos/octo/demo/code-scanning/alerts" ||
        url.pathname === "/repos/octo/demo/dependabot/alerts"
      )
        return jsonResponse({ message: "forbidden" }, 403);
      if (url.pathname === "/repos/octo/demo/secret-scanning/alerts")
        return jsonResponse({ message: "not found" }, 404);
      if (url.pathname === "/repos/octo/demo/commits")
        return jsonResponse([commit]);
      if (url.pathname === "/repos/octo/demo/pulls")
        return jsonResponse([pullRequest]);
      if (url.pathname === "/repos/octo/demo/actions/runs")
        return jsonResponse({ total_count: 0, workflow_runs: [] });
      throw new Error(`unhandled route: ${url}`);
    };
    const { client } = clientFor(limitedRoute);

    const branchRisk = await collectBranchRisk(client, coordinates, "main");
    const security = await collectSecurityPosture(client, coordinates);

    expect(branchRisk.status).toBe("partial");
    expect(branchRisk.protectionStatus).toBe("unknown");
    expect(branchRisk.reason).toContain("HTTP 404");
    expect(security.overallStatus).toBe("unknown");
    expect(security.codeScanning.status).toBe("unknown");
    expect(security.codeScanning.reason).toContain("HTTP 403");
    expect(security.secretScanning.reason).toContain("HTTP 404");
  });

  it("rejects private repositories rather than silently including them", async () => {
    const { client } = clientFor((url) => {
      if (url.pathname === "/repos/octo/demo")
        return jsonResponse({ ...repository, private: true });
      throw new Error(`unhandled route: ${url}`);
    });

    await expect(
      collectRepositoryReadiness(client, coordinates),
    ).rejects.toBeInstanceOf(PrivateRepositoryError);
  });

  it("collects an explicit portfolio with bounded repository concurrency", async () => {
    let activeRepositoryReads = 0;
    let peakRepositoryReads = 0;
    const route: Route = (url) => {
      if (url.pathname.startsWith("/repos/octo/")) {
        if (url.pathname.split("/").length === 4) {
          activeRepositoryReads += 1;
          peakRepositoryReads = Math.max(
            peakRepositoryReads,
            activeRepositoryReads,
          );
          activeRepositoryReads -= 1;
        }
        const repoName = url.pathname.split("/")[3];
        return fullRoute(
          new URL(url.toString().replace("/" + repoName, "/demo")),
        );
      }
      throw new Error(`unhandled route: ${url}`);
    };
    const { client } = clientFor(route);

    const result = await collectPortfolioSnapshot(client, "octo", {
      repositories: [coordinates, { owner: "octo", repo: "second" }],
      concurrency: 1,
    });

    expect(result.repositories).toHaveLength(2);
    expect(result.actionPlan.length).toBeGreaterThan(0);
    expect(result.totals.repositories).toBe(2);
    expect(result.status).toBe("available");
    expect(peakRepositoryReads).toBeLessThanOrEqual(1);
  });
});
