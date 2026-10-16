import { describe, expect, it } from "vitest";
import { runCheck } from "@/practices/checks";
import { CheckSchema, parsePractice } from "@/practices/schema";
import { filesNeeded } from "@/practices/snapshot";
import { makeSnapshot } from "@test/helpers/snapshot";
import type { SnapshotValue } from "@test/helpers/snapshot";

const manifest = {
  scripts: { prepare: "husky" },
  devDependencies: { husky: "^9.1.7", "lint-staged": "^17.6.0" },
  "lint-staged": { "*.ts": ["oxlint --fix", "oxfmt --write"] },
};

function inspect(hook: string, pkg: SnapshotValue = manifest) {
  return runCheck(
    CheckSchema.parse({ type: "husky-lint-staged" }),
    makeSnapshot({
      paths: ["package.json", ".husky/pre-commit"],
      files: { "package.json": JSON.stringify(pkg), ".husky/pre-commit": hook },
    }),
    {},
  );
}

describe("Husky lint-staged wiring", () => {
  it.each([
    "pnpm exec lint-staged\n",
    "npx --no-install lint-staged\n",
    "bunx lint-staged\n",
    "pnpm exec lint-staged --no-stash\n",
    "# Generate Worker types first\n[ -f .cloudflare/types/index.d.ts ] || pnpm run cf-typegen\npnpm exec lint-staged\n",
    "pnpm exec lint-staged\npnpm typecheck\npnpm test\n",
    "pnpm exec lint-staged\nif git diff --cached --name-only | grep -q 'resume.json'; then\n  pnpm pdf && pnpm build || exit 1\nfi\n",
  ])("accepts a real invocation while preserving extra steps: %s", (hook) => {
    expect(inspect(hook).state).toBe("pass");
  });

  it.each(["husky", "husky || true", "bunx husky", "npx --no-install husky"])(
    "recognizes the prepare command %s",
    (prepare) => {
      expect(inspect("pnpm exec lint-staged", { ...manifest, scripts: { prepare } }).state).toBe(
        "pass",
      );
    },
  );

  it.each([
    "# pnpm exec lint-staged\necho ready",
    'echo "pnpm exec lint-staged"',
    "exit 0\npnpm exec lint-staged",
    "pnpm exec lint-staged || true",
    "pnpm exec lint-staged; true",
    "pnpm exec lint-staged --help",
    "pnpm exec lint-staged --version",
  ])("does not credit commented, quoted, unreachable or ignored invocations: %s", (hook) => {
    expect(inspect(hook).state).not.toBe("pass");
  });

  it.each([
    "cat <<EOF\npnpm exec lint-staged\nEOF",
    "if false; then\n  pnpm exec lint-staged\nfi",
    "pnpm exec lint-staged --config lint-staged.config.mjs",
    "echo 'example\npnpm exec lint-staged\n'",
    "echo \\\npnpm exec lint-staged",
    "false &&\npnpm exec lint-staged",
    "false && {\npnpm exec lint-staged\n}",
  ])("keeps unsupported shell/configuration forms unknown: %s", (hook) => {
    expect(inspect(hook).state).toBe("unknown");
  });

  it("requires declared local dependencies, initialization, and non-empty staged tasks", () => {
    expect(inspect("pnpm exec lint-staged", { ...manifest, devDependencies: {} }).state).toBe(
      "fail",
    );
    expect(
      inspect("pnpm exec lint-staged", { ...manifest, scripts: { prepare: "echo husky" } }).state,
    ).toBe("fail");
    expect(inspect("pnpm exec lint-staged", { ...manifest, "lint-staged": {} }).state).toBe("fail");
  });

  it("distinguishes missing files from unavailable files", () => {
    const check = CheckSchema.parse({ type: "husky-lint-staged" });
    expect(runCheck(check, makeSnapshot(), {}).state).toBe("fail");
    expect(runCheck(check, makeSnapshot({ tree: null }), {}).state).toBe("unknown");
    expect(runCheck(check, makeSnapshot({ truncated: true }), {}).state).toBe("unknown");
    expect(
      runCheck(check, makeSnapshot({ files: { "package.json": { error: "HTTP 403" } } }), {}).state,
    ).toBe("unknown");
    expect(
      runCheck(check, makeSnapshot({ paths: ["package.json"], files: { "package.json": "{" } }), {})
        .state,
    ).toBe("unknown");
  });

  it("collects both files through the actual snapshot read planner", () => {
    const parsed = parsePractice(
      "version: 1\nid: hooks\ntitle: Hooks\nsummary: Hooks\nkind: files\nchecks:\n  - type: husky-lint-staged\n",
    );

    if (!parsed.ok) {
      throw new Error("Invalid synthetic practice");
    }

    expect(filesNeeded([parsed.practice])).toEqual(["package.json", ".husky/pre-commit"]);
  });
});
