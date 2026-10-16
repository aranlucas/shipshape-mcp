import { describe, expect, it } from "vitest";
import { runCheck } from "@/practices/checks";
import { CheckSchema, checkLabel } from "@/practices/schema";
import { makeSnapshot, type SnapshotOptions, type SnapshotValue } from "@test/helpers/snapshot";

const check = CheckSchema.parse({ type: "required-package-scripts" });

const scripts = {
  lint: "oxlint",
  format: "oxfmt --config oxfmt.config.ts",
  build: "pnpm ui:build && cf build",
};

const validManifest = { scripts };

function evaluate(manifest: SnapshotValue = validManifest, options: SnapshotOptions = {}) {
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

describe("required package scripts", () => {
  it("accepts actual commands including framework builds and aliases", () => {
    expect(evaluate().state).toBe("pass");
    expect(
      evaluate({
        scripts: { lint: "pnpm lint:code", format: "prettier --write .", build: "vite build" },
      }).state,
    ).toBe("pass");
  });

  it("does not misclassify command substitution as an echo-only placeholder", () => {
    expect(
      evaluate({ scripts: { ...scripts, build: "echo $(node scripts/build.mjs)" } }).state,
    ).toBe("pass");
  });

  it.each(["lint", "format", "build"])("requires a declared %s script", (name) => {
    const remaining = Object.fromEntries(Object.entries(scripts).filter(([key]) => key !== name));

    expect(evaluate({ scripts: remaining })).toMatchObject({
      state: "fail",
      path: "package.json",
      detail: `Declare non-empty scripts with real commands for: ${name}.`,
    });
  });

  it.each<SnapshotValue>(["", " \n\t ", 42, null, false, {}])(
    "rejects an empty or non-string command: %j",
    (value) => {
      expect(evaluate({ scripts: { ...scripts, lint: value } }).state).toBe("fail");
    },
  );

  it.each([
    "echo done",
    "echo 'no build needed'",
    "printf done",
    "true",
    "false",
    ":",
    "exit 0",
    "return 0",
    "# TODO",
    "# lint\n# later",
  ])("rejects obvious placeholders: %s", (lint) => {
    expect(evaluate({ scripts: { ...scripts, lint } }).state).toBe("fail");
  });

  it.each<SnapshotValue>([{}, { scripts: {} }, { scripts: null }, { scripts: [] }])(
    "reports all missing commands: %j",
    (manifest) => {
      expect(evaluate(manifest)).toMatchObject({
        state: "fail",
        detail: "Declare non-empty scripts with real commands for: lint, format, build.",
      });
    },
  );

  it("checks every nested manifest regardless of repository language and ignores other JSON", () => {
    expect(
      evaluate(
        {},
        {
          paths: ["apps/web/package.json", "fixtures/package.json", "not-package.json"],
          files: {
            "apps/web/package.json": JSON.stringify({ scripts }),
            "fixtures/package.json": JSON.stringify({
              scripts: { lint: "oxlint", format: "oxfmt" },
            }),
            "not-package.json": "{}",
          },
          repo: { ...makeSnapshot().repo, language: "Rust" },
        },
      ),
    ).toMatchObject({ state: "fail", path: "fixtures/package.json" });
  });

  it("requires all manifests to pass", () => {
    expect(
      evaluate(
        {},
        {
          paths: ["package.json", "packages/core/package.json"],
          files: {
            "package.json": JSON.stringify({ scripts }),
            "packages/core/package.json": JSON.stringify({ scripts }),
          },
        },
      ).state,
    ).toBe("pass");
  });

  it.each<SnapshotOptions["files"]>([
    {},
    { "package.json": { error: "HTTP 403" } },
    { "package.json": { error: "Read budget exceeded" } },
    { "package.json": "{" },
    { "package.json": "null" },
  ])("preserves unknown for unreadable or malformed manifests: %j", (files) => {
    expect(evaluate({ scripts }, { files }).state).toBe("unknown");
  });

  it("preserves unknown for incomplete inventories", () => {
    expect(evaluate({ scripts }, { tree: null }).state).toBe("unknown");
    expect(evaluate({ scripts }, { truncated: true }).state).toBe("unknown");
  });

  it("reports a known failure despite unreadable manifests and a truncated tree", () => {
    expect(
      evaluate(
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

  it("passes a complete inventory with no manifests and exposes a strict check", () => {
    expect(runCheck(check, makeSnapshot(), {}).state).toBe("pass");
    expect(
      CheckSchema.safeParse({ type: "required-package-scripts", directory: "." }).success,
    ).toBe(false);
    expect(checkLabel(check)).toBe("Every package.json declares lint, format, and build scripts");
  });
});
