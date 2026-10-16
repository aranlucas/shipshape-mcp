import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { runCheck } from "@/practices/checks";
import { CI_WORKFLOW_PATH } from "@/practices/ci-required-checks";
import { CheckSchema, checkLabel } from "@/practices/schema";
import { makeSnapshot, type SnapshotOptions, type SnapshotValue } from "@test/helpers/snapshot";

const check = CheckSchema.parse({ type: "ci-test-script" });

function evaluate(jobs: SnapshotValue, options: SnapshotOptions = {}) {
  return runCheck(
    check,
    makeSnapshot({
      paths: ["package.json", CI_WORKFLOW_PATH],
      files: {
        "package.json": JSON.stringify({ scripts: { test: "vitest run", verify: "pnpm test" } }),
        [CI_WORKFLOW_PATH]: stringify({ jobs }),
      },
      ...options,
    }),
    {},
  );
}

function job(run: string): SnapshotValue {
  return { ci: { steps: [{ uses: "actions/checkout@main" }, { run }] } };
}

describe("CI test script", () => {
  it.each([
    "pnpm test",
    "pnpm run test",
    "npm test",
    "npm run test",
    "yarn test",
    "bun run test",
    "pnpm verify",
  ])("recognizes a package test command: %s", (command) => {
    expect(evaluate(job(command))).toMatchObject({ state: "pass", path: CI_WORKFLOW_PATH });
  });

  it("finds tests in parallel steps and additional jobs", () => {
    expect(
      evaluate({
        build: { steps: [{ run: "pnpm build" }] },
        ci: { steps: [{ parallel: [{ run: "pnpm lint" }, { run: "pnpm test" }] }] },
      }).state,
    ).toBe("pass");
  });

  it.each(["pnpm build", "echo pnpm test", "# pnpm test", "vitest run", "pnpm test:unit"])(
    "requires invocation rather than matching text or a different command: %s",
    (command) => {
      expect(evaluate(job(command)).state).toBe("fail");
    },
  );

  it.each([{}, { scripts: {} }, { scripts: { test: " " } }])(
    "requires a declared test script: %j",
    (manifest) => {
      expect(
        evaluate(job("pnpm test"), { files: { "package.json": JSON.stringify(manifest) } }),
      ).toMatchObject({ state: "fail", path: "package.json" });
    },
  );

  it.each([
    "pnpm test || true",
    "false && pnpm test",
    "pnpm test; true",
    "pnpm\ntest",
    "${{ inputs.command }}",
    "pnpm test --if-present",
  ])("does not pass complex or optional commands: %s", (command) => {
    expect(evaluate(job(command)).state).not.toBe("pass");
  });

  it.each<SnapshotValue>([
    { ci: { steps: [{ run: "pnpm test", if: false }] } },
    { ci: { if: "${{ inputs.test }}", steps: [{ run: "pnpm test" }] } },
    { ci: { steps: [{ run: "pnpm test", "continue-on-error": true }] } },
    { ci: { "continue-on-error": true, steps: [{ run: "pnpm test" }] } },
    { ci: { steps: [{ run: "pnpm test", "working-directory": "packages/web" }] } },
    {
      ci: {
        defaults: { run: { "working-directory": "packages/web" } },
        steps: [{ run: "pnpm test" }],
      },
    },
    { ci: { strategy: { matrix: { package: ["web"] } }, steps: [{ run: "pnpm test" }] } },
    { ci: { uses: "octo/shared/.github/workflows/test.yml@main" } },
  ])("leaves uncertain execution for review: %j", (jobs) => {
    expect(evaluate(jobs).state).toBe("unknown");
  });

  it("bounds script alias recursion", () => {
    expect(
      evaluate(job("pnpm verify"), {
        files: {
          "package.json": '{"scripts":{"test":"vitest run","verify":"pnpm verify"}}',
          [CI_WORKFLOW_PATH]: stringify({ jobs: job("pnpm verify") }),
        },
      }).state,
    ).toBe("unknown");
  });

  it("distinguishes missing files, failed reads, malformed YAML and incomplete inventories", () => {
    expect(evaluate({}, { paths: [], files: {} }).state).toBe("fail");
    const manifest = '{"scripts":{"test":"vitest run"}}';
    expect(
      evaluate({}, { paths: ["package.json"], files: { "package.json": manifest } }),
    ).toMatchObject({ state: "fail", path: CI_WORKFLOW_PATH });
    expect(
      evaluate(
        {},
        { files: { "package.json": manifest, [CI_WORKFLOW_PATH]: { error: "HTTP 403" } } },
      ),
    ).toMatchObject({ state: "unknown", detail: "HTTP 403" });
    expect(
      evaluate({}, { files: { "package.json": manifest, [CI_WORKFLOW_PATH]: "jobs: [" } }).state,
    ).toBe("unknown");
    expect(evaluate({}, { tree: null, files: {} }).state).toBe("unknown");
    expect(evaluate({}, { truncated: true, paths: [], files: {} }).state).toBe("unknown");
    expect(evaluate({}).state).toBe("fail");
  });

  it("exposes a strict catalog check with a readable label", () => {
    expect(CheckSchema.safeParse({ type: "ci-test-script", path: "other.yml" }).success).toBe(
      false,
    );
    expect(checkLabel(check)).toBe("ci.yml runs the declared package test script");
  });
});
