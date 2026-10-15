import { describe, expect, it } from "vitest";
import { collectStandards, collectStandardsSource } from "@/standards/collect";
import { createGitHubOctokit } from "@/github/client";
import { evaluateStandards } from "@/standards/evaluate";
import { jsonResponse, repository } from "@test/helpers/github-fixtures";

const commit = "a".repeat(40);

interface File {
  path: string;
  text: string;
  size?: number;
  mode?: string;
  unavailable?: boolean;
}

interface FixtureOptions {
  visibility?: string;
  sharedVisibility?: string;
}

function fixture(
  extra: File[] = [],
  truncated = false,
  treeError = false,
  options: FixtureOptions = {},
) {
  const files = [
    { path: ".shipshape.yml", text: "baseline: shipshape/recommended@1" },
    { path: "package.json", text: '{"devDependencies":{"vitest":"5.0.3"}}' },
    ...extra,
  ].map((file, index) => ({ ...file, sha: (index + 1).toString(16).padStart(40, "0") }));

  const calls: string[] = [];

  const client = createGitHubOctokit("synthetic-token", (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    expect(init?.method ?? (input instanceof Request ? input.method : "GET")).toBe("GET");
    calls.push(url.toString());

    if (url.pathname === "/repos/octo/demo") {
      return Promise.resolve(
        jsonResponse({ ...repository, visibility: options.visibility ?? "public" }),
      );
    }

    if (url.pathname === "/repos/octo/policy") {
      return Promise.resolve(
        jsonResponse({
          ...repository,
          name: "policy",
          full_name: "octo/policy",
          visibility: options.sharedVisibility ?? "public",
        }),
      );
    }

    if (url.pathname.endsWith("/commits/main")) {
      return Promise.resolve(jsonResponse({ sha: commit }));
    }

    if (url.pathname.endsWith(`/git/trees/${commit}`)) {
      return Promise.resolve(
        treeError
          ? jsonResponse({ message: "Forbidden" }, 403)
          : jsonResponse({
              truncated,
              tree: files.map((file) => ({
                path: file.path,
                sha: file.sha,
                type: "blob",
                mode: file.mode ?? "100644",
                size: file.size ?? file.text.length,
              })),
            }),
      );
    }

    const file = files.find((entry) => url.pathname.endsWith(`/git/blobs/${entry.sha}`));

    return Promise.resolve(
      file && !file.unavailable
        ? jsonResponse({ encoding: "base64", size: file.text.length, content: btoa(file.text) })
        : jsonResponse({ message: "Forbidden" }, 403),
    );
  });

  return { client, calls, files };
}

const coordinates = { owner: "octo", repo: "demo" };

describe("bounded review source collection", () => {
  it("reads selected test/updater configs by immutable SHA but never bulk source", async () => {
    const extra = [
      "vitest.config.ts",
      "playwright.config.mts",
      "vite.config.js",
      ".github/dependabot.yml",
      "renovate.json",
    ].map((path) => ({ path, text: "{}" }));

    const input = fixture([
      ...extra,
      { path: "src/index.ts", text: "throw Error('must not execute')" },
      { path: "test/behavior.test.ts", text: "describe('behavior', () => {})" },
    ]);

    const result = await collectStandardsSource(input.client, coordinates);
    expect(result.commit).toBe(commit);

    for (const file of extra) {
      expect(result.files[file.path]).toBe("{}");
    }

    expect(result.files["src/index.ts"]).toBeNull();
    expect(result.files["test/behavior.test.ts"]).toBeNull();
    expect(input.calls.filter((url) => url.includes("/git/blobs/"))).toHaveLength(7);
  });

  it("preserves the existing evaluator result from the exposed source", async () => {
    const a = fixture();
    const b = fixture();
    const source = await collectStandardsSource(a.client, coordinates);
    const result = await collectStandards(b.client, coordinates);
    expect({ ...result, collectedAt: source.collectedAt }).toEqual(evaluateStandards(source));
  });

  it("preserves baseline collection and prioritizes it over review config reads", async () => {
    const extras = Array.from({ length: 85 }, (_, index) => ({
      path: `a${index}/vitest.config.ts`,
      text: "{}",
    }));

    const baselineFixture = fixture(extras);
    const baseline = await collectStandards(baselineFixture.client, coordinates);
    expect(baseline.audit.checks.find((check) => check.ruleId === "standards.test")?.state).toBe(
      "fail",
    );
    expect(baselineFixture.calls.filter((url) => url.includes("/git/blobs/"))).toHaveLength(2);
    const reviewFixture = fixture(extras);
    const review = await collectStandardsSource(reviewFixture.client, coordinates);
    expect(review.files["package.json"]).toContain("vitest");
    expect(reviewFixture.calls.filter((url) => url.includes("/git/blobs/"))).toHaveLength(81);
  });

  it("keeps unreadable, oversized, symlink, vendored, and generated configs unread", async () => {
    const input = fixture([
      { path: "vitest.config.ts", text: "{}", unavailable: true },
      { path: "playwright.config.ts", text: "{}", size: 128_001 },
      { path: "vite.config.ts", text: "outside.ts", mode: "120000" },
      { path: "vendor/vitest.config.ts", text: "{}" },
      { path: "generated/playwright.config.ts", text: "{}" },
    ]);

    const source = await collectStandardsSource(input.client, coordinates);
    expect(source.files["vitest.config.ts"]).toBeNull();
    expect(source.files["playwright.config.ts"]).toBeNull();
    expect(source.files["vendor/vitest.config.ts"]).toBeNull();
    expect(source.files["generated/playwright.config.ts"]).toBeNull();
    expect(source.files["vite.config.ts"]).toBeUndefined();
    expect(source.unreadablePaths).toContain("vite.config.ts");
    expect(input.calls.filter((url) => url.includes("/git/blobs/"))).toHaveLength(3);
  });

  it("keeps tree failures and truncation explicit in the source", async () => {
    const failed = await collectStandardsSource(fixture([], false, true).client, coordinates);
    expect(failed).toMatchObject({ complete: false, policyState: "unknown", files: {} });
    expect((await collectStandardsSource(fixture([], true).client, coordinates)).complete).toBe(
      false,
    );
  });

  it("rejects internal repository metadata before commit, tree, or blob access", async () => {
    const input = fixture([], false, false, { visibility: "internal" });
    await expect(collectStandardsSource(input.client, coordinates)).rejects.toThrow(
      "Private repositories",
    );
    expect(input.calls).toEqual(["https://api.github.com/repos/octo/demo"]);
  });

  it("rejects internal shared policy metadata before its tree or blob access", async () => {
    const input = fixture([], false, false, { sharedVisibility: "internal" });
    const policy = input.files.find((file) => file.path === ".shipshape.yml");

    if (policy) {
      policy.text = `baseline: shipshape/recommended@1\nextends:\n  owner: octo\n  repo: policy\n  ref: ${commit}\n  path: policy.yml`;
    }

    await expect(collectStandardsSource(input.client, coordinates)).rejects.toThrow(
      "Private repositories",
    );
    expect(input.calls.filter((url) => url.includes("/repos/octo/policy"))).toEqual([
      "https://api.github.com/repos/octo/policy",
    ]);
  });

  it("retains the aggregate 80-content-read cap when review configs are added", async () => {
    const input = fixture(
      Array.from({ length: 85 }, (_, index) => ({
        path: `packages/p${index}/vitest.config.ts`,
        text: "{}",
      })),
    );

    const source = await collectStandardsSource(input.client, coordinates);
    expect(input.calls.filter((url) => url.includes("/git/blobs/"))).toHaveLength(81);
    expect(Object.values(source.files).filter((value) => value === null)).toHaveLength(6);
  });

  it("retains the aggregate byte budget when selected configs are large", async () => {
    const input = fixture(
      Array.from({ length: 30 }, (_, index) => ({
        path: `packages/p${index}/vitest.config.ts`,
        text: "{}",
        size: 128_000,
      })),
    );

    await collectStandardsSource(input.client, coordinates);
    expect(input.calls.filter((url) => url.includes("/git/blobs/"))).toHaveLength(17);
  });
});
