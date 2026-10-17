import { describe, expect, it } from "vitest";
import { runCheck } from "@/practices/checks";
import { CheckSchema } from "@/practices/schema";
import { makeSnapshot, type SnapshotOptions } from "@test/helpers/snapshot";

const check = CheckSchema.parse({ type: "cloudflare-cf-cli" });

function inspect(files: NonNullable<SnapshotOptions["files"]>, options: SnapshotOptions = {}) {
  return runCheck(check, makeSnapshot({ paths: Object.keys(files), files, ...options }), {});
}

function script(command: string): string {
  return JSON.stringify({ scripts: { deploy: command } });
}

describe("Wrangler absence policy", () => {
  it.each<NonNullable<SnapshotOptions["files"]>>([
    {},
    { "package.json": "{}" },
    { "package.json": '{"devDependencies":{"cf":"catalog:"}}' },
    { "package.json": "{}", "cloudflare.config.ts": "throw new Error('never execute')" },
    { "wrangler.toml": "name = 'legacy-config'" },
    { "pnpm-lock.yaml": "wrangler: transitive", "README.md": "wrangler deploy" },
  ])(
    "does not require cf or reject configuration/documentation/transitive entries: %j",
    (files) => {
      expect(inspect(files).state).toBe("pass");
    },
  );

  it.each(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"])(
    "rejects Wrangler in %s of a nested manifest, even alongside cf",
    (section) => {
      expect(
        inspect({
          "package.json": "{}",
          "apps/worker/package.json": JSON.stringify({
            devDependencies: { cf: "1.0.0" },
            [section]: { cf: "1.0.0", wrangler: "^4.0.0" },
          }),
        }),
      ).toMatchObject({ state: "fail", path: "apps/worker/package.json" });
    },
  );

  it("reports a known banned declaration even if its version or scripts are invalid", () => {
    expect(
      inspect({ "package.json": '{"dependencies":{"wrangler":null},"scripts":null}' }).state,
    ).toBe("fail");
  });

  it("rejects npm dependency aliases for Wrangler", () => {
    expect(
      inspect({ "package.json": '{"optionalDependencies":{"deploy-tool":"npm:wrangler@^4"}}' })
        .state,
    ).toBe("fail");
  });

  it("reports a known script invocation even when another script is invalid", () => {
    expect(
      inspect({ "package.json": '{"scripts":{"test":null,"deploy":"wrangler deploy"}}' }).state,
    ).toBe("fail");
  });

  it.each([
    "wrangler deploy",
    "pnpm exec wrangler deploy",
    "pnpm dlx wrangler@4 deploy",
    "yarn exec wrangler dev",
    "npm exec -- wrangler deploy",
    "npx --yes wrangler@4 deploy",
    "bun x wrangler deploy",
    "bunx wrangler deploy",
    "./node_modules/.bin/wrangler deploy",
    '"wrangler" deploy',
    "env CI=1 wrangler deploy",
    "exec wrangler deploy",
    "cf build && wrangler deploy",
    "echo done\nwrangler deploy",
    "if wrangler deploy; then echo done; fi",
    "# deploy\nwrangler deploy",
  ])("rejects explicit commands in any package script: %s", (command) => {
    expect(inspect({ "packages/api/package.json": script(command) })).toMatchObject({
      state: "fail",
      path: "packages/api/package.json",
    });
  });

  it.each([
    "cf deploy",
    "pnpm exec cf build",
    "echo wrangler",
    'echo "avoid wrangler deploy && wrangler dev"',
    "# wrangler deploy\ncf deploy",
    "node scripts/wrangler-report.mjs",
  ])("does not treat comments or arguments as CLI invocations: %s", (command) => {
    expect(inspect({ "package.json": script(command) }).state).toBe("pass");
  });

  it.each([
    "pnpm wrangler deploy",
    "pnpm run wrangler",
    "npx --package wrangler wrangler deploy",
    "pnpm --filter web exec wrangler deploy",
    "bash -c 'wrangler deploy'",
    "eval build",
    "$DEPLOY_COMMAND",
    'echo "$(wrangler deploy)"',
    'echo "`wrangler deploy`"',
    'echo "$($DEPLOY_COMMAND)"',
    "out=`$DEPLOY_COMMAND`",
  ])("preserves review for ambiguous or indirect commands: %s", (command) => {
    expect(inspect({ "package.json": script(command) }).state).toBe("unknown");
  });

  it.each([
    'pr=$(gh pr list --json number)\ngh pr merge "$pr" --squash',
    'echo "$HOME" && version=$(node --version)',
    'sha=$(git rev-parse HEAD) && cf deploy --tag "$sha"',
    String.raw`echo "costs \$(1)"`,
  ])("inspects unquoted command substitutions as ordinary commands: %s", (command) => {
    expect(inspect({ "package.json": script(command) }).state).toBe("pass");
  });

  it("rejects Wrangler inside an unquoted command substitution", () => {
    expect(inspect({ "package.json": script("url=$(wrangler deploy)") }).state).toBe("fail");
  });

  it("passes the Dependabot auto-merge workflow from the catalog", () => {
    const run = [
      'pr=$(gh pr list --head "$HEAD_BRANCH" --state open --json number,author,headRefOid \\',
      String.raw`  --jq ".[] | select(.author.login == \"app/dependabot\" and .headRefOid == \"$HEAD_SHA\") | .number")`,
      'if [ -z "$pr" ]; then',
      '  echo "No open Dependabot PR at $HEAD_SHA; nothing to merge."',
      "  exit 0",
      "fi",
      'gh pr merge "$pr" --squash --delete-branch --match-head-commit "$HEAD_SHA"',
    ];

    expect(
      inspect({
        ".github/workflows/dependabot-automerge.yml": `jobs:\n  merge:\n    steps:\n      - run: |\n${run.map((line) => `          ${line}`).join("\n")}\n`,
      }).state,
    ).toBe("pass");
  });

  it("checks every script, including aliases not referenced by deploy", () => {
    expect(
      inspect({
        "package.json": JSON.stringify({
          scripts: { deploy: "pnpm deploy:worker", "deploy:worker": "wrangler deploy" },
        }),
      }).state,
    ).toBe("fail");
  });

  it("checks YAML workflow parallel run steps without a root manifest", () => {
    expect(
      inspect({
        ".github/workflows/deploy.yaml":
          "jobs:\n  deploy:\n    steps:\n      - parallel:\n          - run: bunx wrangler deploy\n",
      }),
    ).toMatchObject({ state: "fail", path: ".github/workflows/deploy.yaml" });
  });

  it.each(["v3", "a".repeat(40)])("rejects Wrangler actions pinned to %s", (ref) => {
    expect(
      inspect({
        ".github/workflows/deploy.yml": `jobs:\n  deploy:\n    steps:\n      - uses: cloudflare/wrangler-action@${ref}\n`,
      }).state,
    ).toBe("fail");
  });

  it("inspects composite action run and uses steps", () => {
    expect(
      inspect({
        "tooling/deploy/action.yaml":
          "runs:\n  using: composite\n  steps:\n    - run: pnpm exec wrangler deploy\n",
      }).state,
    ).toBe("fail");
    expect(
      inspect({
        "action.yml":
          "runs:\n  using: composite\n  steps:\n    - uses: cloudflare/wrangler-action@v3\n",
      }).state,
    ).toBe("fail");
  });

  it("ignores workflow comments and env/with values that are not commands", () => {
    expect(
      inspect({
        ".github/workflows/deploy.yml":
          "# uses: cloudflare/wrangler-action@v3\nenv:\n  run: wrangler deploy\njobs:\n  deploy:\n    steps:\n      - run: cf deploy\n      - uses: actions/checkout@v6\n        with:\n          run: wrangler deploy\n",
      }).state,
    ).toBe("pass");
  });

  it("keeps reusable workflow implementations unknown", () => {
    expect(
      inspect({
        ".github/workflows/deploy.yml":
          "jobs:\n  deploy:\n    uses: octo/shared/.github/workflows/deploy.yml@main\n",
      }).state,
    ).toBe("unknown");
  });

  it.each<NonNullable<SnapshotOptions["files"]>>([
    { "package.json": "{" },
    { "package.json": '{"scripts":null}' },
    { "package.json": '{"optionalDependencies":[]}' },
    { "package.json": { error: "HTTP 403" } },
    { ".github/workflows/deploy.yml": "jobs: [" },
    { "action.yml": "null" },
  ])("keeps unreadable and invalid evidence unknown: %j", (files) => {
    expect(inspect(files).state).toBe("unknown");
  });

  it("keeps absent content and incomplete inventories unknown", () => {
    expect(inspect({}, { paths: ["package.json"] }).state).toBe("unknown");
    expect(inspect({}, { tree: null }).state).toBe("unknown");
    expect(inspect({ "package.json": "{}" }, { truncated: true }).state).toBe("unknown");
    expect(inspect({ "package.json": { error: "Read budget exceeded" } }).state).toBe("unknown");
  });

  it("prioritizes observed violations over unavailable files and truncated inventories", () => {
    expect(
      inspect(
        {
          "package.json": { error: "HTTP 403" },
          "packages/worker/package.json": script("wrangler deploy"),
        },
        { truncated: true },
      ),
    ).toMatchObject({ state: "fail", path: "packages/worker/package.json" });
  });

  it("uses a strict repository-wide definition without the old directory option", () => {
    expect(CheckSchema.safeParse({ type: "cloudflare-cf-cli", directory: "." }).success).toBe(
      false,
    );
  });
});
