import { describe, expect, it, vi } from "vitest";
import { Octokit } from "octokit";

import { PrivateRepositoryError } from "../../src/github/client";
import {
  collectBranchRisk,
  collectDeliveryHygiene,
  collectPortfolioSnapshot,
  collectPublicRepository,
  collectRepositoryReadiness,
  collectSecurityPosture,
} from "../../src/github/collectors";

import { collectPortfolioReport } from "../../src/github/portfolio";
import { evaluateDeliveryHygiene } from "../../src/domain/evaluate";
import { buildActionPlan } from "../../src/domain/scoring";

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

function jsonResponse(
  value: unknown,
  status = 200,
  nextUrl?: string,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      ...(nextUrl ? { link: `<${nextUrl}>; rel="next"` } : {}),
    },
  });
}

type Route = (url: URL, init?: RequestInit) => Response;

function clientFor(route: Route): { client: Octokit; calls: URL[] } {
  const calls: URL[] = [];
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      calls.push(url);
      const response = route(url, init);
      Object.defineProperty(response, "url", { value: url.toString() });
      return response;
    },
  );
  return {
    client: new Octokit({
      auth: "token",
      request: { fetch: fetcher },
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
    expect(result).not.toHaveProperty("actionPlan");
    expect(
      result.evidence.every((item) =>
        item.url.startsWith("https://github.com/"),
      ),
    ).toBe(true);
    expect(calls.every((url) => url.pathname !== "/graphql")).toBe(true);
  });

  it("does not treat open security alerts as readiness failures when domain checks pass", async () => {
    const { client } = clientFor((url) => {
      if (url.pathname === "/repos/octo/demo") {
        return jsonResponse({
          ...repository,
          topics: ["demo", "mcp", "github"],
          allow_merge_commit: false,
        });
      }
      return fullRoute(url);
    });

    const result = await collectRepositoryReadiness(client, coordinates);

    expect(result.securityPosture).toMatchObject({
      overallStatus: "needs-attention",
      codeScanning: { value: { openAlerts: 1, highSeverityAlerts: 1 } },
    });
    expect(result.status).toBe("ready");
    expect(result).not.toHaveProperty("actionPlan");
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
      collectPublicRepository(client, coordinates),
    ).rejects.toBeInstanceOf(PrivateRepositoryError);
  });

  it("collects security posture without commits, pull requests, or workflow runs", async () => {
    const { client, calls } = clientFor((url) => {
      if (url.pathname === "/repos/octo/demo") return jsonResponse(repository);
      if (url.pathname === "/repos/octo/demo/branches/main")
        return jsonResponse(branch);
      if (url.pathname === "/repos/octo/demo/branches/main/protection")
        return jsonResponse(protection);
      if (
        url.pathname === "/repos/octo/demo/code-scanning/alerts" ||
        url.pathname === "/repos/octo/demo/dependabot/alerts" ||
        url.pathname === "/repos/octo/demo/secret-scanning/alerts"
      )
        return jsonResponse([]);
      throw new Error(`unhandled route: ${url}`);
    });

    const fact = await collectPublicRepository(client, coordinates);
    await Promise.all([
      collectBranchRisk(client, coordinates, fact.defaultBranch),
      collectSecurityPosture(client, coordinates),
    ]);

    const paths = calls.map((url) => url.pathname);
    expect(paths).toContain("/repos/octo/demo");
    expect(paths).not.toContain("/repos/octo/demo/commits");
    expect(paths).not.toContain("/repos/octo/demo/pulls");
    expect(paths).not.toContain("/repos/octo/demo/actions/runs");
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

    expect(result.scope).toEqual({
      selection: "explicit",
      status: "complete",
      listing: null,
      filters: null,
      maxRepositories: null,
      eligibleRepositories: 2,
      selectedRepositories: 2,
      omittedRepositories: 0,
    });
    expect(result.repositories).toHaveLength(2);
    expect(result).not.toHaveProperty("actionPlan");
    expect(result.totals.needsAttention).toBe(2);
    expect(result.totals.repositories).toBe(2);
    expect(result.status).toBe("available");
    expect(peakRepositoryReads).toBeLessThanOrEqual(1);
  });
});

describe("observation coverage through collector and report interfaces", () => {
  it("retains capped delivery counts and uncertainty in checks and action evidence", async () => {
    const { client, calls } = clientFor((url) => {
      const data = url.pathname.endsWith("/commits")
        ? [commit]
        : url.pathname.endsWith("/pulls")
          ? [pullRequest]
          : { total_count: 2, workflow_runs: [workflowRun] };
      return jsonResponse(data, 200, `${url.origin}${url.pathname}?page=2`);
    });
    const result = await collectDeliveryHygiene(client, coordinates, "main", {
      maxPages: 1,
      perPage: 1,
      since: "2026-08-01T00:00:00Z",
      until: "2026-08-31T00:00:00Z",
    });
    expect(calls).toHaveLength(3);
    expect(result).toMatchObject({
      status: "partial",
      ciStatus: "unknown",
      recentCommits: 1,
      openPullRequests: 1,
      draftPullRequests: 1,
      workflowRuns: 1,
      coverage: {
        branch: "main",
        commitWindow: {
          since: "2026-08-01T00:00:00Z",
          until: "2026-08-31T00:00:00Z",
        },
      },
    });
    for (const scope of [
      result.coverage.commits,
      result.coverage.pullRequests,
      result.coverage.workflowRuns,
    ]) {
      expect(scope).toMatchObject({
        status: "truncated",
        fetchedCount: 1,
        countKind: "lower_bound",
        limits: { maxPages: 1, perPage: 1 },
        nextUrl: expect.stringContaining("page=2"),
      });
    }
    expect(result.reason).toContain("counts are lower bounds");
    const checks = evaluateDeliveryHygiene(result);
    expect(checks).toContainEqual(
      expect.objectContaining({ ruleId: "delivery.ci-present", state: "pass" }),
    );
    expect(checks).toContainEqual(
      expect.objectContaining({
        ruleId: "delivery.ci-green",
        state: "unknown",
      }),
    );
    const plan = buildActionPlan(checks);
    expect(plan.items[0]).toMatchObject({
      ruleId: "delivery.ci-green",
      state: "unknown",
    });
    expect(plan.items[0]?.remediation).toContain(
      "Inspect additional workflow history",
    );
    expect(plan.items[0]?.evidence).toContainEqual(
      expect.objectContaining({
        detail: expect.stringContaining("Workflow run coverage: truncated"),
      }),
    );
    const commitsUrl = calls.find((url) => url.pathname.endsWith("/commits"));
    expect(commitsUrl?.searchParams.get("since")).toBe(
      result.coverage.commitWindow.since,
    );
    expect(commitsUrl?.searchParams.get("until")).toBe(
      result.coverage.commitWindow.until,
    );
  });

  it("finds the previously unobserved failing workflow when the next page is scanned", async () => {
    const { client, calls } = clientFor((url) => {
      if (!url.pathname.endsWith("/actions/runs")) return fullRoute(url);
      if (url.searchParams.get("page") === "2")
        return jsonResponse({
          total_count: 2,
          workflow_runs: [
            { ...workflowRun, id: 8, name: "E2E", conclusion: "failure" },
          ],
        });
      return jsonResponse(
        { total_count: 2, workflow_runs: [workflowRun] },
        200,
        "https://api.github.com/repos/octo/demo/actions/runs?page=2",
      );
    });
    const result = await collectDeliveryHygiene(client, coordinates, "main", {
      maxPages: 2,
      perPage: 1,
    });
    expect(
      calls.filter((url) => url.pathname.endsWith("/actions/runs")),
    ).toHaveLength(2);
    expect(result).toMatchObject({
      status: "available",
      ciStatus: "degraded",
      workflowRuns: 2,
      coverage: {
        workflowRuns: {
          status: "complete",
          fetchedCount: 2,
          countKind: "exact",
          nextUrl: null,
        },
      },
    });
  });

  it("keeps an observed latest failure actionable even with truncated workflow history", async () => {
    const { client } = clientFor((url) =>
      url.pathname.endsWith("/actions/runs")
        ? jsonResponse(
            {
              total_count: 2,
              workflow_runs: [{ ...workflowRun, conclusion: "failure" }],
            },
            200,
            "https://api.github.com/repos/octo/demo/actions/runs?page=2",
          )
        : fullRoute(url),
    );
    const result = await collectDeliveryHygiene(client, coordinates, "main", {
      maxPages: 1,
    });
    expect(result).toMatchObject({ ciStatus: "degraded", status: "partial" });
    expect(evaluateDeliveryHygiene(result)).toContainEqual(
      expect.objectContaining({ ruleId: "delivery.ci-green", state: "fail" }),
    );
  });

  it("labels exhausted delivery queries complete with effective clamped limits", async () => {
    const { client } = clientFor(fullRoute);
    const result = await collectDeliveryHygiene(client, coordinates, "main", {
      maxPages: 100,
      perPage: 200,
    });
    expect(result).toMatchObject({
      status: "available",
      ciStatus: "healthy",
      coverage: {
        workflowRuns: {
          status: "complete",
          fetchedCount: 1,
          countKind: "exact",
          limits: { maxPages: 20, perPage: 100 },
          nextUrl: null,
        },
      },
    });
  });

  it("keeps permission-limited workflow coverage unavailable rather than an exact zero", async () => {
    const { client } = clientFor((url) =>
      url.pathname.endsWith("/actions/runs")
        ? jsonResponse({ message: "forbidden" }, 403)
        : fullRoute(url),
    );
    const result = await collectDeliveryHygiene(client, coordinates, "main", {
      maxPages: 1,
    });
    expect(result).toMatchObject({
      status: "partial",
      ciStatus: "unknown",
      workflowRuns: null,
      coverage: {
        workflowRuns: {
          status: "unavailable",
          fetchedCount: null,
          countKind: "unknown",
          nextUrl: null,
        },
        commits: { status: "complete" },
      },
    });
    expect(result.reason).toContain("HTTP 403");
  });

  it("keeps wholly unavailable delivery collection unknown", async () => {
    const { client } = clientFor(() =>
      jsonResponse({ message: "not found" }, 404),
    );
    const result = await collectDeliveryHygiene(client, coordinates, "main");
    expect(result).toMatchObject({
      status: "unknown",
      ciStatus: "unknown",
      recentCommits: null,
      coverage: {
        commits: { status: "unavailable" },
        pullRequests: { status: "unavailable" },
        workflowRuns: { status: "unavailable" },
      },
    });
  });

  it("reports the unscanned owner continuation when filters exclude the entire first page", async () => {
    const nextUrl = "https://api.github.com/users/octo/repos?page=2";
    const { client, calls } = clientFor(() =>
      jsonResponse([{ ...repository, fork: true }], 200, nextUrl),
    );
    const report = await collectPortfolioReport(client, "octo", {
      limit: 4,
      includeForks: false,
      includeArchived: false,
    });
    expect(calls).toHaveLength(1);
    expect(report).toMatchObject({
      status: "partial",
      scannedRepositories: 0,
      availableRepositories: 1,
      results: [],
      scope: {
        selection: "owner",
        status: "truncated",
        eligibleRepositories: 0,
        selectedRepositories: 0,
        omittedRepositories: 0,
        maxRepositories: 4,
        filters: { includeForks: false, includeArchived: false },
        listing: {
          status: "truncated",
          fetchedCount: 1,
          countKind: "lower_bound",
          limits: { maxPages: 1, perPage: 50 },
          nextUrl,
        },
      },
    });
  });

  it("reports a complete empty selection only when the owner listing is exhausted", async () => {
    const { client, calls } = clientFor(() =>
      jsonResponse([{ ...repository, archived: true }]),
    );
    const report = await collectPortfolioReport(client, "octo", {
      limit: 4,
      includeForks: false,
      includeArchived: false,
    });
    expect(calls).toHaveLength(1);
    expect(report).toMatchObject({
      status: "available",
      scannedRepositories: 0,
      scope: {
        status: "complete",
        eligibleRepositories: 0,
        listing: { status: "complete", countKind: "exact", nextUrl: null },
      },
    });
  });

  it("keeps scan selection truncation distinct from an exhausted owner listing", async () => {
    const { client, calls } = clientFor((url) => {
      if (url.pathname === "/users/octo/repos")
        return jsonResponse([
          repository,
          { ...repository, name: "second", full_name: "octo/second" },
        ]);
      if (url.pathname.endsWith("/actions/runs"))
        return jsonResponse(
          { total_count: 2, workflow_runs: [workflowRun] },
          200,
          "https://api.github.com/repos/octo/demo/actions/runs?page=2",
        );
      return fullRoute(url);
    });
    const report = await collectPortfolioReport(client, "octo", {
      limit: 1,
      includeForks: false,
      includeArchived: false,
    });
    expect(calls.some((url) => url.pathname.includes("second"))).toBe(false);
    expect(report).toMatchObject({
      status: "partial",
      scannedRepositories: 1,
      availableRepositories: 2,
      scope: {
        status: "truncated",
        eligibleRepositories: 2,
        selectedRepositories: 1,
        omittedRepositories: 1,
        listing: { status: "complete", countKind: "exact" },
      },
      results: [
        {
          deliveryCoverage: {
            workflowRuns: { status: "truncated", countKind: "lower_bound" },
          },
          score: {
            checks: expect.arrayContaining([
              expect.objectContaining({
                ruleId: "delivery.ci-green",
                state: "unknown",
              }),
            ]),
          },
        },
      ],
    });
  });

  it("reports an unavailable owner listing with unknown counts", async () => {
    const { client } = clientFor(() =>
      jsonResponse({ message: "forbidden" }, 403),
    );
    const report = await collectPortfolioReport(client, "octo", {
      limit: 4,
      includeForks: false,
      includeArchived: false,
    });
    expect(report).toMatchObject({
      status: "unknown",
      availableRepositories: null,
      scannedRepositories: 0,
      scope: {
        status: "unavailable",
        eligibleRepositories: null,
        omittedRepositories: null,
        listing: {
          status: "unavailable",
          fetchedCount: null,
          countKind: "unknown",
        },
      },
    });
  });

  it("states an explicit empty scope without making an owner listing request", async () => {
    const { client, calls } = clientFor(() => {
      throw new Error("must not list");
    });
    const snapshot = await collectPortfolioSnapshot(client, "octo", {
      repositories: [],
    });
    expect(calls).toHaveLength(0);
    expect(snapshot.scope).toMatchObject({
      selection: "explicit",
      listing: null,
      status: "complete",
      eligibleRepositories: 0,
      selectedRepositories: 0,
    });
  });
});
