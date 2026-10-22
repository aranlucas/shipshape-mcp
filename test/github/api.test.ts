import { Octokit } from "octokit";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { GITHUB_API_VERSION } from "@/config";
import { createGitHubOctokit, octokitGet, octokitPaginate } from "@/github/client";
import { GitHubPayloadError } from "@/github/payload-error";
import { GitHubRefInputSchema, RepositoryCoordinatesSchema } from "@/github/schemas";

describe("GitHub API boundaries", () => {
  it("recovers a transient 500 with bounded retries", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ message: "temporary failure" }, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ id: 42 }));

    const client = createGitHubOctokit("token", fetcher, { retry: "bounded" });

    await expect(
      octokitGet(client, "GET /items", {}, z.object({ id: z.number() })),
    ).resolves.toMatchObject({ data: { id: 42 } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([500, 502, 503, 504, 401, 403, 404, 409, 422, 429])(
    "bounds retries for HTTP %s without retrying permission or feature errors",
    async (status) => {
      const fetcher = vi.fn(() =>
        Promise.resolve(Response.json({ message: "unavailable" }, { status })),
      );

      const client = createGitHubOctokit("token", fetcher, { retry: "bounded" });

      await expect(
        octokitGet(client, "GET /items", {}, z.object({ id: z.number() })),
      ).rejects.toMatchObject({ status });
      expect(fetcher).toHaveBeenCalledTimes(status >= 500 ? 3 : 1);
    },
  );

  it("does not replay catalog writes with retries disabled after HTTP 500", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(Response.json({ message: "temporary failure" }, { status: 500 })),
    );

    const client = createGitHubOctokit("token", fetcher, { retry: false });

    await expect(
      client.request("POST /repos/{owner}/{repo}/git/commits", {
        owner: "octo",
        repo: "practices",
        message: "Update practice",
        tree: "a".repeat(40),
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses shared Zod schemas for repository coordinates and refs", () => {
    expect(RepositoryCoordinatesSchema.parse({ owner: "octo", repo: "demo.js" })).toEqual({
      owner: "octo",
      repo: "demo.js",
    });
    expect(() => RepositoryCoordinatesSchema.parse({ owner: "../octo", repo: "demo" })).toThrow(
      z.ZodError,
    );
    expect(() => GitHubRefInputSchema.parse("feature/../main")).toThrow(z.ZodError);
  });

  it("turns invalid GitHub payloads into a boundary error", async () => {
    const client = createGitHubOctokit("test-token", () =>
      Promise.resolve(Response.json({ id: "42" })),
    );

    await expect(
      octokitGet(client, "GET /items", {}, z.object({ id: z.number() })),
    ).rejects.toThrow(GitHubPayloadError);
  });

  it("uses Octokit pagination while honoring the page cap", async () => {
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const page = Number(url.searchParams.get("page") ?? "1");

      const response = new Response(JSON.stringify([{ id: page }]), {
        headers: {
          "content-type": "application/json",
          link: `<https://api.github.com/items?page=${page + 1}>; rel="next"`,
        },
      });

      Object.defineProperty(response, "url", { value: url.toString() });

      return Promise.resolve(response);
    });

    const octokit = new Octokit({ request: { fetch: fetcher } });

    const result = await octokitPaginate(octokit, "GET /items", {}, z.object({ id: z.number() }), {
      maxPages: 2,
      perPage: 1,
    });

    expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("sends the pinned GitHub REST API version on Octokit requests", async () => {
    let apiVersion: string | null = null;

    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      apiVersion = new Headers(init?.headers).get("x-github-api-version");
      const url = new URL(input instanceof Request ? input.url : input.toString());

      const response = new Response(JSON.stringify({ login: "octo" }), {
        headers: { "content-type": "application/json" },
      });

      Object.defineProperty(response, "url", { value: url.toString() });

      return Promise.resolve(response);
    });

    const octokit = createGitHubOctokit("token", fetcher);

    await octokitGet(octokit, "GET /user", {}, z.object({ login: z.string() }));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(apiVersion).toBe(GITHUB_API_VERSION);
  });
});
