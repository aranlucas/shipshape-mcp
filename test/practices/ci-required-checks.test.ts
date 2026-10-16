import { describe, expect, it } from "vitest";
import { runCheck } from "@/practices/checks";
import { CI_WORKFLOW_PATH } from "@/practices/ci-required-checks";
import { GitHubBranchProtectionSchema } from "@/github/schemas";
import { protectionState, type BranchProtectionFact } from "@/practices/protection";
import { CheckSchema, checkLabel } from "@/practices/schema";
import { makeSnapshot, type SnapshotOptions } from "@test/helpers/snapshot";

const check = CheckSchema.parse({ type: "ci-required-checks" });

const workflow = `name: CI
on: [push, pull_request]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm check
`;

function protectedBranch(contexts: string[]): BranchProtectionFact {
  return {
    status: "protected",
    protection: protectionState(
      GitHubBranchProtectionSchema.parse({ required_status_checks: { contexts } }),
    ),
  };
}

function evaluate(content = workflow, options: SnapshotOptions = {}) {
  return runCheck(
    check,
    makeSnapshot({
      paths: [CI_WORKFLOW_PATH],
      files: { [CI_WORKFLOW_PATH]: content },
      protection: { main: protectedBranch(["ci"]) },
      ...options,
    }),
    {},
  );
}

describe("CI required status checks", () => {
  it("has no catalog options and describes the default-branch requirement", () => {
    expect(CheckSchema.safeParse({ type: "ci-required-checks", branch: "main" }).success).toBe(
      false,
    );
    expect(checkLabel(check)).toBe("ci.yml jobs are required status checks on the default branch");
  });

  it("requires the job ID, rather than the workflow title or filename", () => {
    expect(evaluate()).toMatchObject({
      state: "pass",
      path: CI_WORKFLOW_PATH,
      expected: '["ci"]',
      actual: '["ci"]',
    });
    expect(
      evaluate(workflow, { protection: { main: protectedBranch(["CI", "ci.yml"]) } }),
    ).toMatchObject({
      state: "fail",
      detail: "Require these status checks before merging into main: ci.",
    });
  });

  it("uses explicit job names, requires every job, and permits additional required checks", () => {
    const content =
      workflow.replace("  ci:\n", "  ci:\n    name: Verify\n") +
      "  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm build\n";

    expect(
      evaluate(content, { protection: { main: protectedBranch(["build", "Verify", "security"]) } }),
    ).toMatchObject({ state: "pass", expected: '["Verify","build"]' });
    expect(evaluate(content, { protection: { main: protectedBranch(["Verify"]) } })).toMatchObject({
      state: "fail",
      detail: "Require these status checks before merging into main: build.",
    });
  });

  it.each<BranchProtectionFact>([
    { status: "unprotected" },
    { status: "protected", protection: protectionState(GitHubBranchProtectionSchema.parse({})) },
    protectedBranch([]),
  ])("fails when branch protection does not require CI: $status", (fact) => {
    expect(evaluate(workflow, { protection: { main: fact } })).toMatchObject({
      state: "fail",
      actual: "[]",
    });
  });

  it("uses the repository default branch instead of hardcoding main", () => {
    const snapshot = makeSnapshot();
    expect(
      evaluate(workflow, {
        repo: { ...snapshot.repo, defaultBranch: "develop" },
        protection: { develop: protectedBranch(["ci"]) },
      }).state,
    ).toBe("pass");
  });

  it("preserves unreadable and uncollected protection as unknown", () => {
    expect(evaluate(workflow, { protection: {} }).state).toBe("unknown");
    expect(
      evaluate(workflow, {
        protection: {
          main: { status: "unknown", reason: "GitHub returned HTTP 403 for branch protection." },
        },
      }),
    ).toMatchObject({
      state: "unknown",
      detail: "GitHub returned HTTP 403 for branch protection.",
    });
  });

  it("distinguishes missing, unreadable, and undiscovered workflow files", () => {
    expect(evaluate(workflow, { paths: [], files: {} }).state).toBe("fail");
    expect(
      evaluate(workflow, { files: { [CI_WORKFLOW_PATH]: { error: "Read budget exceeded" } } }),
    ).toMatchObject({ state: "unknown", detail: "Read budget exceeded" });
    expect(evaluate(workflow, { tree: null, files: {} }).state).toBe("unknown");
    expect(evaluate(workflow, { truncated: true, paths: [], files: {} }).state).toBe("unknown");
    expect(evaluate(workflow, { files: {} }).state).toBe("unknown");
  });

  it.each([
    "jobs: [",
    "jobs:\n  ci: {}\n  ci: {}",
    "jobs: []",
    "jobs:\n  ci: null",
    workflow.replace("  ci:\n", "  ci:\n    name: '${{ github.event_name }}'\n"),
    workflow.replace("  ci:\n", "  ci:\n    name: 42\n"),
    workflow.replace("  ci:\n", "  ci:\n    strategy:\n      matrix:\n        node: [22, 24]\n"),
    "jobs:\n  ci:\n    uses: octo/shared/.github/workflows/ci.yml@main\n",
    workflow + "  other:\n    name: ci\n    runs-on: ubuntu-latest\n",
  ])("keeps unsupported or ambiguous workflow names unknown: %s", (content) => {
    expect(evaluate(content).state).toBe("unknown");
  });

  it("fails an empty job map instead of passing vacuously", () => {
    expect(evaluate("jobs: {}")).toMatchObject({
      state: "fail",
      detail: "The CI workflow has no jobs to require.",
    });
  });
});
