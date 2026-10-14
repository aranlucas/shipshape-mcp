import { describe, expect, it } from "vitest";
import { collectStandards } from "@/standards/collect";
import { createGitHubOctokit } from "@/github/client";
import { jsonResponse, repository } from "@test/helpers/github-fixtures";

const commit = "a".repeat(40);

const policy =
  "baseline: shipshape/recommended@1\nconvergence: {profile: oxforge@1, version: 0.2.2}";

const manifest = JSON.stringify({
  devDependencies: { "@aranlucas/oxforge": "0.2.2" },
  scripts: { lint: "oxlint" },
});

const config = '{"extends":["./node_modules/@aranlucas/oxforge/configs/recommended.json"]}';

interface FileFixture {
  path: string;
  text: string;
  size?: number;
  mode?: string;
  unavailable?: boolean;
}

function client(extra: FileFixture[] = [], truncated = false, privateRepo = false) {
  const files = [
    { path: ".shipshape.yml", text: policy },
    { path: "package.json", text: manifest },
    ...extra,
  ].map((file, index) => ({ ...file, sha: (index + 1).toString(16).padStart(40, "0") }));

  const urls: string[] = [];

  const octokit = createGitHubOctokit("synthetic-token", (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    expect(init?.method ?? (input instanceof Request ? input.method : "GET")).toBe("GET");
    urls.push(url.toString());

    if (url.pathname === "/repos/octo/demo") {
      return Promise.resolve(jsonResponse({ ...repository, private: privateRepo }));
    }

    if (url.pathname.endsWith("/commits/main")) {
      return Promise.resolve(jsonResponse({ sha: commit }));
    }

    if (url.pathname.endsWith(`/git/trees/${commit}`)) {
      return Promise.resolve(
        jsonResponse({
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

    if (file && !file.unavailable) {
      return Promise.resolve(
        jsonResponse({ encoding: "base64", size: file.text.length, content: btoa(file.text) }),
      );
    }

    return Promise.resolve(jsonResponse({ message: "Unavailable fixture" }, 403));
  });

  return { octokit, urls, files };
}

const coordinates = { owner: "octo", repo: "demo" };

describe("bounded convergence collection", () => {
  it("reads selected configs with immutable blob references and GET only", async () => {
    const fixture = client([{ path: ".oxlintrc.json", text: config }]);
    const result = await collectStandards(fixture.octokit, coordinates);
    expect(result.convergence).toEqual({ profile: "oxforge@1", version: "0.2.2" });
    expect(
      result.audit.checks.find((check) => check.ruleId === "standards.oxforge-lint")?.state,
    ).toBe("pass");
    expect(fixture.urls).toContain(
      `https://api.github.com/repos/octo/demo/git/trees/${commit}?recursive=1`,
    );
    expect(
      result.audit.checks
        .flatMap((check) => check.evidence)
        .every((item) => item.url.includes(`/blob/${commit}/`)),
    ).toBe(true);
  });

  it.each([
    { path: ".oxlintrc.json", text: config, unavailable: true, read: true },
    { path: ".oxlintrc.json", text: config, size: 128_001, read: false },
    { path: ".oxlintrc.json", text: "outside.json", mode: "120000", read: false },
  ])("keeps unreadable, oversized, and symlink config unknown: $path $read", async (file) => {
    const fixture = client([file]);
    const result = await collectStandards(fixture.octokit, coordinates);
    expect(
      result.audit.checks.find((check) => check.ruleId === "standards.oxforge-lint")?.state,
    ).toBe("unknown");
    expect(result.complete).toBe(false);
    expect(fixture.urls.some((url) => url.endsWith(`/git/blobs/${fixture.files[2]?.sha}`))).toBe(
      file.read,
    );
  });

  it("keeps budget-skipped config unknown and caps content requests", async () => {
    const filler = Array.from({ length: 85 }, (_, index) => ({
      path: `a${index}/package.json`,
      text: "{}",
    }));

    const fixture = client([...filler, { path: "zz/oxlint.json", text: config }]);
    const root = fixture.files.find((file) => file.path === "package.json");

    if (root) {
      root.text = JSON.stringify({ scripts: { lint: "oxlint --config zz/oxlint.json" } });
    }

    const result = await collectStandards(fixture.octokit, coordinates);
    expect(result.complete).toBe(false);
    expect(
      result.packages
        .find((pkg) => pkg.path === ".")
        ?.audit.checks.find((check) => check.ruleId === "standards.oxforge-lint")?.state,
    ).toBe("unknown");
    // One separate policy read, plus at most 80 candidate content reads.
    expect(fixture.urls.filter((url) => url.includes("/git/blobs/")).length).toBeLessThanOrEqual(
      81,
    );
  });

  it("does not infer absent config from a truncated tree", async () => {
    const fixture = client([], true);
    const result = await collectStandards(fixture.octokit, coordinates);
    expect(
      result.audit.checks.find((check) => check.ruleId === "standards.oxforge-lint")?.state,
    ).toBe("unknown");
  });

  it("does not count symlink lockfiles or manifests in the existing baseline", async () => {
    const fixture = client([
      { path: "pnpm-lock.yaml", text: "outside.yaml", mode: "120000" },
      { path: "fake/package.json", text: "outside.json", mode: "120000" },
    ]);

    const localPolicy = fixture.files.find((file) => file.path === ".shipshape.yml");

    if (localPolicy) {
      localPolicy.text = "baseline: shipshape/recommended@1";
    }

    const result = await collectStandards(fixture.octokit, coordinates);
    expect(result.audit.checks.find((check) => check.ruleId === "standards.lockfile")?.state).toBe(
      "fail",
    );
    expect(result.packages).toHaveLength(1);
    expect(result.audit.checks).toHaveLength(10);
  });

  it("rejects private repositories before any tree or blob access", async () => {
    const fixture = client([], false, true);
    await expect(collectStandards(fixture.octokit, coordinates)).rejects.toThrow(
      "Private repositories",
    );
    expect(fixture.urls).toEqual(["https://api.github.com/repos/octo/demo"]);
  });
});
