import { describe, expect, it } from "vitest";
import type { CheckResult, RepoSummary } from "@/api/contract";
import { evidenceLink } from "@/ui/evidence";

const repo: RepoSummary = {
  fullName: "octo/demo",
  owner: "octo",
  name: "demo",
  private: true,
  archived: false,
  fork: false,
  language: "TypeScript",
  defaultBranch: "main",
  pushedAt: null,
  url: "https://github.com/octo/demo",
};

const sha = "a".repeat(40);

const check: CheckResult = {
  type: "file-contains",
  label: "config",
  state: "fail",
  path: "config/a #.json",
  expected: "value",
  actual: "different",
  detail: null,
};

describe("inspection evidence links", () => {
  it.each(["portless-dev", "cloudflare-cf-cli"])("links %s to the captured manifest", (type) => {
    expect(evidenceLink(repo, sha, { ...check, type, path: "apps/web/package.json" })).toBe(
      `https://github.com/octo/demo/blob/${sha}/apps/web/package.json`,
    );
  });
  it("links required-script failures to the evaluated package manifest", () => {
    expect(
      evidenceLink(repo, sha, {
        ...check,
        type: "required-package-scripts",
        path: "packages/core/package.json",
      }),
    ).toBe(`https://github.com/octo/demo/blob/${sha}/packages/core/package.json`);
  });
  it.each(["ci-required-checks", "pr-workflow-efficiency"])(
    "links %s job definitions at the evaluated commit",
    (type) => {
      expect(
        evidenceLink(repo, sha, {
          ...check,
          type,
          path: ".github/workflows/ci.yml",
        }),
      ).toBe(`https://github.com/octo/demo/blob/${sha}/.github/workflows/ci.yml`);
    },
  );
  it("pins and encodes file evidence at the individual evaluated commit", () => {
    expect(evidenceLink(repo, sha, check)).toBe(
      `https://github.com/octo/demo/blob/${sha}/config/a%20%23.json`,
    );
  });
  it("links semantic formatter evidence to the inspected config", () => {
    expect(
      evidenceLink(repo, sha, { ...check, type: "oxforge-format", path: "oxfmt.config.ts" }),
    ).toBe(`https://github.com/octo/demo/blob/${sha}/oxfmt.config.ts`);
  });
  it("uses the inspected tree for a missing file", () => {
    expect(evidenceLink(repo, sha, { ...check, type: "file-exists", actual: "false" })).toBe(
      `https://github.com/octo/demo/tree/${sha}`,
    );
  });
  it("links Husky evidence to the evaluated hook", () => {
    expect(
      evidenceLink(repo, sha, { ...check, type: "husky-lint-staged", path: ".husky/pre-commit" }),
    ).toBe(`https://github.com/octo/demo/blob/${sha}/.husky/pre-commit`);
  });
  it("does not invent source evidence for settings, missing SHAs or unsafe paths", () => {
    expect(evidenceLink(repo, sha, { ...check, type: "branch-protection" })).toBeNull();
    expect(evidenceLink(repo, null, check)).toBeNull();
    expect(evidenceLink(repo, "main", check)).toBeNull();
    expect(evidenceLink(repo, sha, { ...check, path: "../secret" })).toBeNull();
  });
});
