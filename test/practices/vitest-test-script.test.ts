import { describe, expect, it } from "vitest";
import { runCheck } from "@/practices/checks";
import { checkLabel, CheckSchema } from "@/practices/schema";
import { makeSnapshot } from "@test/helpers/snapshot";
import type { SnapshotOptions, SnapshotValue } from "@test/helpers/snapshot";

const check = CheckSchema.parse({ type: "vitest-test-script" });

const invalidManifests: SnapshotValue[] = [
  {},
  { scripts: {} },
  { scripts: { test: "" } },
  { scripts: { test: 42 } },
];

function inspect(manifest: SnapshotValue, options: SnapshotOptions = {}) {
  return runCheck(
    check,
    makeSnapshot({
      paths: ["package.json"],
      files: { "package.json": JSON.stringify(manifest) },
      ...options,
    }),
    {},
  );
}

describe("Vitest test scripts", () => {
  it.each([
    "vitest",
    "vitest run",
    "vitest run --coverage --project=node",
    "pnpm vitest run",
    "pnpm exec vitest run",
    "npx vitest run",
    "npx --no-install vitest run",
    "npm exec -- vitest run",
    "yarn vitest run",
    "yarn exec vitest run",
    "bunx vitest run",
    "bun x vitest run",
  ])("accepts direct Vitest execution: %s", (test) => {
    expect(inspect({ scripts: { test } }).state).toBe("pass");
  });

  it.each(invalidManifests)("requires a non-empty test script: %j", (manifest) => {
    expect(inspect(manifest)).toMatchObject({ state: "fail", path: "package.json" });
  });

  it.each([
    "jest",
    "echo vitest",
    "vitest-other run",
    "vitest --help",
    "vitest --version",
    "vitest -v",
    "vitest list",
    "vitest init browser",
  ])("does not credit another command or information-only invocation: %s", (test) => {
    expect(inspect({ scripts: { test } }).state).toBe("fail");
  });

  it.each([
    "pnpm run test:unit",
    "node scripts/test.mjs",
    "echo 'vitest run'",
    "vitest run || true",
    "false && vitest run",
    "vitest run; true",
    "env CI=1 vitest run",
    "vitest run --config 'vitest.config.ts'",
  ])("leaves indirect or complex scripts for review: %s", (test) => {
    expect(inspect({ scripts: { test } }).state).toBe("unknown");
  });

  it("checks nested packages even without a root manifest or JavaScript language", () => {
    const snapshot = makeSnapshot({
      paths: ["packages/core/package.json", "fixtures/example/package.json"],
      files: {
        "packages/core/package.json": '{"scripts":{"test":"vitest run"}}',
        "fixtures/example/package.json": "{}",
      },
    });

    snapshot.repo = { ...snapshot.repo, language: "Rust" };
    expect(runCheck(check, snapshot, {})).toMatchObject({
      state: "fail",
      path: "fixtures/example/package.json",
    });
  });

  it("requires every manifest to pass and ignores other JSON filenames", () => {
    expect(
      inspect(
        {},
        {
          paths: ["package.json", "packages/core/package.json", "not-package.json"],
          files: {
            "package.json": '{"scripts":{"test":"vitest run"}}',
            "packages/core/package.json": '{"scripts":{"test":"vitest"}}',
            "not-package.json": "{}",
          },
        },
      ).state,
    ).toBe("pass");
  });

  it("preserves unknown for unavailable inventories, missing reads and invalid JSON", () => {
    expect(inspect({}, { tree: null }).state).toBe("unknown");
    expect(inspect({ scripts: { test: "vitest" } }, { truncated: true }).state).toBe("unknown");

    const unavailableFiles: SnapshotOptions["files"][] = [
      {},
      { "package.json": { error: "HTTP 403" } },
      { "package.json": { error: "Read budget exceeded" } },
      { "package.json": "{" },
    ];

    for (const files of unavailableFiles) {
      expect(inspect({}, { files }).state).toBe("unknown");
    }
  });

  it("reports known failures despite unreadable files and a truncated tree", () => {
    expect(
      inspect(
        {},
        {
          paths: ["package.json", "packages/core/package.json"],
          files: {
            "package.json": { error: "HTTP 403" },
            "packages/core/package.json": "{}",
          },
          truncated: true,
        },
      ),
    ).toMatchObject({ state: "fail", path: "packages/core/package.json" });
  });

  it("passes a complete inventory without manifests and labels the rule", () => {
    expect(runCheck(check, makeSnapshot(), {}).state).toBe("pass");
    expect(checkLabel(check)).toBe("Every package.json has a test script that runs Vitest");
  });
});
