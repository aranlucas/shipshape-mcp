import { Octokit } from "octokit";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  GitHubPayloadError,
  octokitPaginate,
  parseGitHubPayload,
} from "../../src/github/client";
import {
  GitHubRefInputSchema,
  RepositoryCoordinatesSchema,
} from "../../src/github/schemas";

describe("GitHub API boundaries", () => {
  it("uses shared Zod schemas for repository coordinates and refs", () => {
    expect(
      RepositoryCoordinatesSchema.parse({ owner: "octo", repo: "demo.js" }),
    ).toEqual({ owner: "octo", repo: "demo.js" });
    expect(() =>
      RepositoryCoordinatesSchema.parse({ owner: "../octo", repo: "demo" }),
    ).toThrow();
    expect(() => GitHubRefInputSchema.parse("feature/../main")).toThrow();
  });

  it("turns invalid GitHub payloads into a boundary error", () => {
    expect(() =>
      parseGitHubPayload(z.object({ id: z.number() }), { id: "42" }),
    ).toThrow(GitHubPayloadError);
  });

  it("uses Octokit pagination while honoring the page cap", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page") ?? "1");
      const response = new Response(JSON.stringify([{ id: page }]), {
        headers: {
          "content-type": "application/json",
          link: `<https://api.github.com/items?page=${page + 1}>; rel="next"`,
        },
      });
      Object.defineProperty(response, "url", { value: url.toString() });
      return response;
    });
    const octokit = new Octokit({ request: { fetch: fetcher } });

    const result = await octokitPaginate(
      octokit,
      "GET /items",
      {},
      z.object({ id: z.number() }),
      { maxPages: 2, perPage: 1 },
    );

    expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
