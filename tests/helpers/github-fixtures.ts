import type { ConfigValue } from "../../src/standards/config-value";
import { vi } from "vitest";
import { Octokit } from "octokit";

export const coordinates = { owner: "octo", repo: "demo" } as const;

export const repository = {
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

export const branch = {
  name: "main",
  protected: true,
  commit: {
    sha: "a".repeat(40),
    url: "https://api.github.com/repos/octo/demo/commits/a",
  },
};

export const protection = {
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

export const commit = {
  sha: "b".repeat(40),
  html_url:
    "https://github.com/octo/demo/commit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  commit: {
    message: "ship it",
    author: { date: "2026-08-29T00:00:00Z" },
    committer: { date: "2026-08-29T00:00:00Z" },
  },
};

export const pullRequest = {
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

export const workflowRun = {
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

export function jsonResponse(
  value: ConfigValue,
  status = 200,
  nextUrl?: string,
): Response {
  const headers = new Headers({ "content-type": "application/json" });

  if (nextUrl) headers.set("link", `<${nextUrl}>; rel="next"`);

  return new Response(JSON.stringify(value), { status, headers });
}

export type Route = (url: URL, init?: RequestInit) => Response;

export function clientFor(route: Route) {
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

export function fullRoute(url: URL): Response {
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
