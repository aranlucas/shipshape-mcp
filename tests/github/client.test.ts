import { describe, expect, it, vi } from "vitest";

import {
  GitHubApiError,
  GitHubClient,
  GitHubInputError,
  GitHubResponseTooLargeError,
  mapWithConcurrency,
  validateOwner,
  validateRef,
  validateRepository,
} from "../../src/github/client";
import { GitHubRepositorySchema } from "../../src/github/schemas";

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
  security_and_analysis: {
    advanced_security: { status: "enabled" },
    secret_scanning: { status: "enabled" },
    secret_scanning_push_protection: { status: "enabled" },
  },
};

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function mockedFetch(responses: Response[]): {
  fetcher: typeof fetch;
  calls: Array<{ input: RequestInfo | URL; init?: RequestInit }>;
} {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ input, init });
      const response = responses.shift();
      if (!response) throw new Error("unexpected fetch call");
      return response;
    },
  );
  return { fetcher: fetcher as typeof fetch, calls };
}

describe("GitHubClient", () => {
  it("sends a read-only request with the API version and bearer token", async () => {
    const mock = mockedFetch([jsonResponse(repository)]);
    const client = new GitHubClient({
      token: "gho_test-token",
      fetch: mock.fetcher,
    });

    const result = await client.getRepository({ owner: "octo", repo: "demo" });
    const init = mock.calls[0]?.init;
    const headers = new Headers(init?.headers);

    expect(result.data.full_name).toBe("octo/demo");
    expect(init?.method).toBe("GET");
    expect(headers.get("authorization")).toBe("Bearer gho_test-token");
    expect(headers.get("x-github-api-version")).toBe("2026-03-10");
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(String(mock.calls[0]?.input)).not.toContain("gho_test-token");
    expect("post" in client).toBe(false);
    expect("patch" in client).toBe(false);
    expect("delete" in client).toBe(false);
  });

  it("rejects private repository responses before exposing them to collectors", async () => {
    const mock = mockedFetch([jsonResponse({ ...repository, private: true })]);
    const client = new GitHubClient({ token: "token", fetch: mock.fetcher });

    await expect(
      client.getRepository({ owner: "octo", repo: "demo" }),
    ).rejects.toMatchObject({ code: "private_repository" });
  });

  it("uses an ETag on repeat reads and serves a cached 304 representation", async () => {
    const mock = mockedFetch([
      jsonResponse(repository, 200, { etag: '"v1"' }),
      new Response(null, { status: 304 }),
    ]);
    const client = new GitHubClient({ token: "token", fetch: mock.fetcher });

    await client.getRepository({ owner: "octo", repo: "demo" });
    const second = await client.getRepository({ owner: "octo", repo: "demo" });
    const secondHeaders = new Headers(mock.calls[1]?.init?.headers);

    expect(second.data.full_name).toBe("octo/demo");
    expect(second.metadata.notModified).toBe(true);
    expect(second.metadata.etag).toBe('"v1"');
    expect(secondHeaders.get("if-none-match")).toBe('"v1"');
  });

  it("follows Link pagination but stops at the configured page bound", async () => {
    const commit = {
      sha: "a".repeat(40),
      html_url:
        "https://github.com/octo/demo/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      commit: {
        message: "one",
        author: { date: "2026-08-29T00:00:00Z" },
        committer: { date: "2026-08-29T00:00:00Z" },
      },
    };
    const next =
      '<https://api.github.com/repos/octo/demo/commits?page=2&per_page=1>; rel="next"';
    const mock = mockedFetch([
      jsonResponse([commit], 200, { link: next }),
      jsonResponse([commit]),
    ]);
    const client = new GitHubClient({
      token: "token",
      fetch: mock.fetcher,
      maxPages: 2,
    });

    const result = await client.listCommits(
      { owner: "octo", repo: "demo" },
      { perPage: 1 },
    );

    expect(result.data).toHaveLength(2);
    expect(mock.calls).toHaveLength(2);
    expect(String(mock.calls[0]?.input)).toContain("page=1");
    expect(String(mock.calls[1]?.input)).toContain("page=2");
  });

  it("parses workflow-run envelopes while preserving pagination bounds", async () => {
    const run = {
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
    const mock = mockedFetch([
      jsonResponse({ total_count: 2, workflow_runs: [run] }, 200, {
        link: '<https://api.github.com/repos/octo/demo/actions/runs?page=2&per_page=1>; rel="next"',
      }),
      jsonResponse({ total_count: 2, workflow_runs: [run] }),
    ]);
    const client = new GitHubClient({
      token: "token",
      fetch: mock.fetcher,
      maxPages: 2,
    });

    const result = await client.listWorkflowRuns(
      { owner: "octo", repo: "demo" },
      { ref: "main", perPage: 1 },
    );

    expect(result.data).toHaveLength(2);
    expect(String(mock.calls[0]?.input)).toContain("branch=main");
  });

  it("returns typed rate-limit metadata on API errors", async () => {
    const mock = mockedFetch([
      jsonResponse({ message: "forbidden" }, 403, {
        "x-ratelimit-limit": "60",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1730000000",
        "retry-after": "4",
      }),
    ]);
    const client = new GitHubClient({ token: "token", fetch: mock.fetcher });

    const failure = await client
      .get("/repos/octo/demo", GitHubRepositorySchema)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubApiError);
    expect(failure).toMatchObject({
      status: 403,
      metadata: {
        rateLimit: { remaining: 0, resetAt: 1730000000, retryAfterSeconds: 4 },
      },
    });
  });

  it("rejects oversized responses before parsing JSON", async () => {
    const mock = mockedFetch([
      jsonResponse(repository, 200, { "content-length": "999" }),
    ]);
    const client = new GitHubClient({
      token: "token",
      fetch: mock.fetcher,
      maxResponseBytes: 100,
    });

    await expect(
      client.getRepository({ owner: "octo", repo: "demo" }),
    ).rejects.toBeInstanceOf(GitHubResponseTooLargeError);
  });

  it("validates owner, repository, refs, timeout, and concurrency bounds", async () => {
    expect(() => validateOwner("../octo")).toThrow(GitHubInputError);
    expect(() => validateRepository("octo/demo")).toThrow(GitHubInputError);
    expect(() => validateRef("feature/../main")).toThrow(GitHubInputError);
    expect(
      () => new GitHubClient({ token: "token", timeoutMs: 5_999 }),
    ).toThrow(GitHubInputError);
    await expect(
      mapWithConcurrency([], 0, async () => undefined),
    ).rejects.toBeInstanceOf(GitHubInputError);
  });

  it("keeps asynchronous work within the requested concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const result = await mapWithConcurrency(
      [1, 2, 3, 4, 5],
      2,
      async (value) => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return value * 2;
      },
    );

    expect(result).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
