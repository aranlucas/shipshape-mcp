import { describe, expect, it } from "vitest";
import { runCheck } from "@/practices/checks";
import { CheckSchema, parsePractice } from "@/practices/schema";
import { filesNeeded } from "@/practices/snapshot";
import { LINT_STAGED_CONFIG_NAMES } from "@/practices/lint-staged";
import { makeSnapshot } from "@test/helpers/snapshot";
import type { SnapshotValue } from "@test/helpers/snapshot";

type PackageScripts = Record<string, string>;

type ScriptEntry = [string, string];

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
    "pnpm exec lint-staged\npnpm typecheck\npnpm test\n",
    "pnpm exec lint-staged\nif git diff --cached --name-only | grep -q 'resume.json'; then\n  pnpm pdf && pnpm build || exit 1\nfi\n",
    "#!/usr/bin/env sh\n# Check staged files\npnpm exec lint-staged # local checks\n",
    "lint-staged",
    "npm exec -- lint-staged --concurrent false --no-stash",
    "set -eu\npnpm exec lint-staged && pnpm test",
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
    "[ -f .cloudflare/types/index.d.ts ] || pnpm run cf-typegen\npnpm exec lint-staged\n",
    "set +e\npnpm exec lint-staged\ntrue",
    "false\npnpm exec lint-staged",
    "pnpm exec lint-staged --cwd other-package",
    "pnpm exec lint-staged --diff HEAD~1",
  ])("keeps unsupported shell/configuration forms unknown: %s", (hook) => {
    expect(inspect(hook).state).toBe("unknown");
  });

  it("requires declared local dependencies, initialization, and non-empty staged tasks", () => {
    expect(inspect("pnpm exec lint-staged", { ...manifest, devDependencies: {} }).state).toBe(
      "fail",
    );
    expect(
      inspect("pnpm exec lint-staged", { ...manifest, scripts: { prepare: "echo husky" } }).state,
    ).toBe("unknown");
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

    expect(filesNeeded([parsed.practice])).toEqual([
      "package.json",
      ".husky/pre-commit",
      ...LINT_STAGED_CONFIG_NAMES,
    ]);
  });

  it("accepts postinstall, chained setup and package-script installation aliases", () => {
    const setups: PackageScripts[] = [
      { postinstall: "husky" },
      { prepare: "husky && pnpm build" },
      { prepare: "npm run hooks", hooks: "husky" },
    ];

    for (const scripts of setups) {
      expect(inspect("pnpm exec lint-staged", { ...manifest, scripts }).state).toBe("pass");
    }

    expect(inspect("pnpm exec lint-staged", { ...manifest, scripts: {} }).state).toBe("fail");
    expect(
      inspect("pnpm exec lint-staged", {
        ...manifest,
        scripts: { prepare: "node .husky/install.mjs" },
      }).state,
    ).toBe("unknown");
  });

  it("resolves package scripts instead of crediting a shadowed binary name", () => {
    for (const runner of ["pnpm", "yarn", "bun run"]) {
      const hook = `${runner} lint-staged`;
      expect(
        inspect(hook, { ...manifest, scripts: { prepare: "husky", "lint-staged": "echo skipped" } })
          .state,
      ).toBe("unknown");
      expect(
        inspect(`${hook} --no-stash`, {
          ...manifest,
          scripts: { prepare: "husky", "lint-staged": "echo skipped" },
        }).state,
      ).toBe("unknown");
      expect(
        inspect(hook, {
          ...manifest,
          scripts: { prepare: "husky", "lint-staged": "pnpm exec lint-staged" },
        }).state,
      ).toBe("pass");
    }

    expect(
      inspect("npm run check-staged", {
        ...manifest,
        scripts: { prepare: "husky", "check-staged": "pnpm exec lint-staged && pnpm typecheck" },
      }).state,
    ).toBe("pass");
    expect(
      inspect("pnpm exec lint-staged", {
        ...manifest,
        scripts: { prepare: "husky", exec: "echo skipped" },
      }).state,
    ).toBe("pass");
  });

  it("keeps script cycles, long alias chains and swallowed script failures unknown", () => {
    expect(
      inspect("pnpm run a", {
        ...manifest,
        scripts: { prepare: "husky", a: "pnpm run b", b: "pnpm run a" },
      }).state,
    ).toBe("unknown");

    const scripts = Object.fromEntries<string>([
      ["prepare", "husky"],
      ...Array.from({ length: 9 }, (_, index): ScriptEntry => [
        `check${index}`,
        `pnpm run check${index + 1}`,
      ]),
      ["check9", "pnpm exec lint-staged"],
    ]);

    expect(inspect("pnpm run check0", { ...manifest, scripts }).state).toBe("unknown");

    for (const body of ["pnpm exec lint-staged\ntrue", "pnpm exec lint-staged || true"]) {
      expect(
        inspect("pnpm run checks", { ...manifest, scripts: { prepare: "husky", checks: body } })
          .state,
      ).toBe("unknown");
    }

    expect(inspect("pnpm run lint-staged").state).toBe("unknown");
    expect(inspect("pnpm exec lint-staged && true\ntrue").state).toBe("unknown");
  });

  it.each([
    [".lintstagedrc", '{"*.ts": "oxlint"}'],
    [".lintstagedrc.json", '{"*.ts": ["oxlint", "oxfmt"]}'],
    [".lintstagedrc.yml", '"*.ts": oxlint'],
  ])("accepts external static task configuration in %s", (path, content) => {
    const snapshot = makeSnapshot({
      paths: ["package.json", ".husky/pre-commit", path],
      files: {
        "package.json": JSON.stringify({ ...manifest, "lint-staged": undefined }),
        ".husky/pre-commit": "npx lint-staged",
        [path]: content,
      },
    });

    const check = CheckSchema.parse({ type: "husky-lint-staged" });
    expect(runCheck(check, snapshot, {}).state).toBe("pass");
    snapshot.files.set(path, { error: "Read budget exceeded" });
    expect(runCheck(check, snapshot, {}).state).toBe("unknown");
  });

  it("distinguishes missing tasks, invalid maps and ambiguous or dynamic configuration", () => {
    const check = CheckSchema.parse({ type: "husky-lint-staged" });

    const snapshot = makeSnapshot({
      paths: ["package.json", ".husky/pre-commit"],
      files: {
        "package.json": JSON.stringify({ ...manifest, "lint-staged": undefined }),
        ".husky/pre-commit": "npx lint-staged",
      },
    });

    expect(runCheck(check, snapshot, {}).state).toBe("fail");
    snapshot.tree?.paths.add(".lintstagedrc.json");
    snapshot.files.set(".lintstagedrc.json", '"*.ts": oxlint');
    expect(runCheck(check, snapshot, {}).state).toBe("unknown");
    snapshot.files.set(".lintstagedrc.json", '{"*.ts": []}');
    expect(runCheck(check, snapshot, {}).state).toBe("fail");
    snapshot.tree?.paths.add("lint-staged.config.mjs");
    snapshot.files.set("lint-staged.config.mjs", "throw new Error('never execute')");
    expect(runCheck(check, snapshot, {}).state).toBe("unknown");
    snapshot.tree?.paths.delete(".lintstagedrc.json");
    expect(runCheck(check, snapshot, {}).state).toBe("unknown");
    snapshot.tree?.paths.delete("lint-staged.config.mjs");
    snapshot.files.set("package.json", JSON.stringify(manifest));

    if (snapshot.tree) {
      snapshot.tree.truncated = true;
    }

    expect(runCheck(check, snapshot, {}).state).toBe("unknown");
  });
});
