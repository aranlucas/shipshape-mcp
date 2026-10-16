import { describe, expect, it } from "vitest";
import { runCheck } from "@/practices/checks";
import { CheckSchema } from "@/practices/schema";
import { filesNeeded } from "@/practices/snapshot";
import { makeSnapshot } from "@test/helpers/snapshot";
import type { SnapshotOptions } from "@test/helpers/snapshot";

const manager = CheckSchema.parse({ type: "preferred-package-manager" });

const setup = CheckSchema.parse({ type: "pnpm-setup" });

function inspect(files: NonNullable<SnapshotOptions["files"]>, setupOnly = false) {
  return runCheck(
    setupOnly ? setup : manager,
    makeSnapshot({ paths: Object.keys(files), files }),
    {},
  );
}

function manifest(packageManager: string, script = "vitest run") {
  return JSON.stringify({ packageManager, scripts: { test: script } });
}

describe("preferred package managers", () => {
  it.each(["pnpm@12.11.2", "bun@1.4.0"])("accepts %s", (name) => {
    expect(inspect({ "package.json": manifest(name) }).state).toBe("pass");
  });

  it.each(["npm@11.0.0", "yarn@4.0.0"])("rejects %s", (name) => {
    expect(inspect({ "package.json": manifest(name) }).state).toBe("fail");
  });

  it("requires a root declaration but permits workspace inheritance", () => {
    expect(inspect({ "package.json": "{}" }).state).toBe("fail");
    expect(
      inspect({ "package.json": manifest("pnpm@12.11.2"), "apps/web/package.json": "{}" }).state,
    ).toBe("pass");
    expect(
      inspect({ "package.json": '{"devEngines":{"packageManager":{"name":"bun"}}}' }).state,
    ).toBe("pass");
    expect(
      inspect({
        "package.json":
          '{"packageManager":"pnpm@12","devEngines":{"packageManager":{"name":"npm"}}}',
      }).state,
    ).toBe("fail");
  });

  it.each(["package-lock.json", "packages/web/npm-shrinkwrap.json"])(
    "rejects tracked %s",
    (path) => {
      expect(inspect({ [path]: "{}" })).toMatchObject({ state: "fail", path });
    },
  );

  it.each([
    "npm test",
    "npx vitest",
    "pnpm lint && npm test",
    "CI=1 npm ci",
    "env CI=1 npm ci",
    "cross-env CI=1 npm ci",
    '"npm" test',
    "if npm test; then exit 0; fi",
  ])("rejects explicit commands: %s", (command) => {
    expect(inspect({ "package.json": manifest("pnpm@12", command) }).state).toBe("fail");
  });

  it.each([
    "pnpm test",
    "bun run test",
    "bunx vitest",
    "echo npm",
    'echo "avoid foo && npm ci"',
    "# avoid foo && npm ci\npnpm test",
    "node scripts/npm-report.mjs",
  ])("allows %s", (command) => {
    expect(inspect({ "package.json": manifest("pnpm@12", command) }).state).toBe("pass");
  });

  it("checks nested workflow steps and local composite actions", () => {
    expect(
      inspect({
        ".github/workflows/ci.yml":
          "jobs:\n  test:\n    steps:\n      - parallel:\n          - run: npm ci\n",
      }).state,
    ).toBe("fail");
    expect(
      inspect({
        "tooling/setup/action.yaml": "runs:\n  using: composite\n  steps:\n    - run: npx vitest\n",
      }).state,
    ).toBe("fail");
  });

  it("preserves unknown for invalid and unreadable files and incomplete inventories", () => {
    for (const text of ["{", { error: "Read budget exceeded" }]) {
      expect(inspect({ "package.json": text }).state).toBe("unknown");
    }

    expect(runCheck(manager, makeSnapshot({ tree: null }), {}).state).toBe("unknown");
    expect(runCheck(manager, makeSnapshot({ truncated: true }), {}).state).toBe("unknown");
    expect(inspect({ ".github/workflows/ci.yml": "jobs: [" }).state).toBe("unknown");
    expect(runCheck(manager, makeSnapshot({ paths: ["package.json"] }), {}).state).toBe("unknown");
  });

  it("reports known violations despite incomplete inventories", () => {
    expect(
      runCheck(manager, makeSnapshot({ paths: ["package-lock.json"], truncated: true }), {}).state,
    ).toBe("fail");
  });
});

describe("pnpm setup action policy", () => {
  it.each(["pnpm/action-setup@v6", `pnpm/action-setup@${"a".repeat(40)}`, "PNPM/ACTION-SETUP@v6"])(
    "rejects %s even when pinned",
    (reference) => {
      expect(
        inspect(
          { "tooling/setup/action.yml": `runs:\n  steps:\n    - uses: ${reference}\n` },
          true,
        ),
      ).toMatchObject({ state: "fail", path: "tooling/setup/action.yml" });
    },
  );

  it.each(["pnpm/setup@v3", "oven-sh/setup-bun@v2", "example/pnpm-action-setup@v1"])(
    "allows %s",
    (reference) => {
      expect(
        inspect(
          {
            ".github/workflows/ci.yml": `jobs:\n  test:\n    steps:\n      - uses: ${reference}\n`,
          },
          true,
        ).state,
      ).toBe("pass");
    },
  );

  it("ignores comments and reports unknown when source cannot be read", () => {
    expect(
      inspect({ ".github/workflows/ci.yml": "# uses: pnpm/action-setup@v6\njobs: {}\n" }, true)
        .state,
    ).toBe("pass");
    expect(inspect({ "action.yml": { error: "HTTP 403" } }, true).state).toBe("unknown");
  });

  it("does not inspect manifests for the action-only check", () => {
    expect(inspect({ "package.json": "{" }, true).state).toBe("pass");
  });

  it("requests manifests, workflows and composites at the captured commit", () => {
    expect(
      filesNeeded([
        {
          version: 1,
          id: "package-manager",
          title: "Package manager",
          summary: "Package manager",
          kind: "files",
          appliesTo: { include: ["*"], exclude: [], archived: false, forks: false },
          checks: [manager, setup],
        },
      ]),
    ).toEqual(["**/package.json", ".github/workflows/*", "**/action.yml"]);
  });
});
