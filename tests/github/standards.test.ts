import { Octokit } from "octokit";
import { describe, expect, it, vi } from "vitest";
import { collectStandards } from "../../src/standards/collect";
const sha = "a".repeat(40);
const fileSha = "b".repeat(40);
const repository = {
  id: 1,
  name: "demo",
  full_name: "octo/demo",
  private: false,
  html_url: "https://github.com/octo/demo",
  default_branch: "main",
  archived: false,
  fork: false,
};
function client(
  options: {
    private?: boolean;
    truncated?: boolean;
    treeError?: boolean;
    blobError?: boolean;
    config?: string;
    sharedPrivate?: boolean;
    sharedSymlink?: boolean;
  } = {},
) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    let data: unknown = {};
    let status = 200;
    const shared = url.pathname.startsWith("/repos/octo/policy");
    if (/\/repos\/octo\/(demo|policy)$/.test(url.pathname))
      data = {
        ...repository,
        private: shared
          ? (options.sharedPrivate ?? false)
          : (options.private ?? false),
      };
    else if (url.pathname.endsWith("/commits/main")) data = { sha };
    else if (url.pathname.includes("/git/trees/")) {
      if (options.treeError) {
        status = 403;
        data = { message: "Forbidden" };
      } else
        data = {
          truncated: options.truncated ?? false,
          tree: shared
            ? [
                {
                  path: "policy.yml",
                  sha: fileSha,
                  type: "blob",
                  mode: options.sharedSymlink ? "120000" : "100644",
                  size: 100,
                },
              ]
            : [
                {
                  path: "package.json",
                  sha: fileSha,
                  type: "blob",
                  mode: "100644",
                  size: 2,
                },
                ...(options.config
                  ? [
                      {
                        path: ".shipshape.yml",
                        sha,
                        type: "blob",
                        mode: "100644",
                        size: options.config.length,
                      },
                    ]
                  : []),
              ],
        };
    } else if (url.pathname.includes("/git/blobs/")) {
      if (options.blobError) {
        status = 403;
        data = { message: "Forbidden" };
      } else {
        const text = shared
          ? "baseline: shipshape/recommended@1"
          : url.pathname.endsWith(sha)
            ? (options.config ?? "")
            : "{}";
        data = { encoding: "base64", size: text.length, content: btoa(text) };
      }
    } else {
      status = 404;
      data = { message: "Not found" };
    }
    const response = new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });
    Object.defineProperty(response, "url", { value: url.toString() });
    return response;
  });
  return {
    octokit: new Octokit({
      request: { fetch },
      retry: { enabled: false },
      throttle: { enabled: false },
    }),
    fetch,
  };
}
const coordinates = { owner: "octo", repo: "demo" };
const sharedConfig = `baseline: shipshape/recommended@1\nextends:\n  owner: octo\n  repo: policy\n  ref: ${sha}\n  path: policy.yml`;
describe("standards collection", () => {
  it("pins tree reads and evidence to the resolved commit", async () => {
    const { octokit, fetch } = client();
    const result = await collectStandards(octokit, coordinates);
    expect(result.commit).toBe(sha);
    expect(result.status).toBe("needs-attention");
    expect(fetch.mock.calls.map(([input]) => String(input))).toContain(
      `https://api.github.com/repos/octo/demo/git/trees/${sha}?recursive=1`,
    );
    expect(
      result.audit.checks
        .flatMap((check) => check.evidence)
        .every((item) => item.url.includes(`/blob/${sha}/`)),
    ).toBe(true);
  });
  it("rejects private repositories before reading their files", async () => {
    const { octokit, fetch } = client({ private: true });
    await expect(collectStandards(octokit, coordinates)).rejects.toThrow(
      "Private repositories",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps permission failures unknown", async () => {
    const { octokit } = client({ treeError: true });
    const result = await collectStandards(octokit, coordinates);
    expect(result.status).toBe("unknown");
    expect(result.complete).toBe(false);
  });
  it("does not report missing config when the tree is truncated", async () => {
    const { octokit } = client({ truncated: true });
    const result = await collectStandards(octokit, coordinates);
    expect(
      result.audit.checks.find((check) => check.ruleId === "standards.baseline")
        ?.state,
    ).toBe("unknown");
  });
  it("loads a local baseline and reports unreadable manifests", async () => {
    const { octokit } = client({ config: "baseline: shipshape/recommended@1" });
    expect(
      (await collectStandards(octokit, coordinates)).audit.checks.find(
        (check) => check.ruleId === "standards.baseline",
      )?.state,
    ).toBe("pass");
    const blocked = client({ blobError: true });
    expect(
      (
        await collectStandards(blocked.octokit, coordinates)
      ).packages[0]?.audit.checks.find(
        (check) => check.ruleId === "standards.test",
      )?.state,
    ).toBe("unknown");
  });
  it("loads a pinned public shared policy", async () => {
    const { octokit } = client({ config: sharedConfig });
    const result = await collectStandards(octokit, coordinates);
    expect(result.policyEvidence).toBe(
      `https://github.com/octo/policy/blob/${sha}/policy.yml`,
    );
  });
  it("rejects private shared policies and does not dereference symlinks", async () => {
    const privatePolicy = client({ config: sharedConfig, sharedPrivate: true });
    await expect(
      collectStandards(privatePolicy.octokit, coordinates),
    ).rejects.toThrow("Private repositories");
    const symlink = client({ config: sharedConfig, sharedSymlink: true });
    expect((await collectStandards(symlink.octokit, coordinates)).status).toBe(
      "unknown",
    );
    expect(
      symlink.fetch.mock.calls.some(([input]) =>
        String(input).includes("/repos/octo/policy/git/blobs/"),
      ),
    ).toBe(false);
  });
  it("returns an actionable error for malformed policy", async () => {
    const { octokit } = client({ config: "baseline: latest" });
    await expect(collectStandards(octokit, coordinates)).rejects.toThrow(
      "Invalid .shipshape.yml",
    );
  });
});
