/* oxlint-disable anti-slop/no-unknown-parameters */

import { describe, expect, it } from "vitest";
import { createGitHubOctokit } from "@/github/client";
import { CheckSchema, type Check, type Practice } from "@/practices/schema";
import { runCheck } from "@/practices/checks";
import { filesNeeded, takeSnapshot } from "@/practices/snapshot";
import { snapshotRepository } from "@test/helpers/snapshot";
import { repository } from "@test/helpers/github-fixtures";

const headSha = "b".repeat(40);

type CheckInput = Record<string, string | boolean | undefined>;

function check(value: CheckInput): Check {
  return CheckSchema.parse(value);
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function practice(checks: Check[], id = "practice"): Practice {
  return {
    version: 1,
    id,
    title: id,
    summary: "Snapshot fixture",
    kind: checks.some((item) => item.type === "setting" || item.type === "branch-protection")
      ? "settings"
      : "files",
    appliesTo: { include: ["*"], exclude: [], archived: false, forks: false },
    checks,
  };
}

interface SnapshotClientOptions {
  treePaths?: string[];
  treeStatus?: number;
  treeMessage?: string;
  commitStatus?: number;
  commitMessage?: string;
  contents?: Record<string, { content: string; size?: number } | { error: number }>;
  settings?: Record<string, boolean>;
  protection?: boolean;
}

function snapshotClient(options: SnapshotClientOptions = {}) {
  const calls: URL[] = [];

  const client = createGitHubOctokit(
    "synthetic-token",
    (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      calls.push(url);
      expect(init?.method ?? (input instanceof Request ? input.method : "GET")).toBe("GET");

      if (url.pathname === "/repos/octo/demo") {
        return Promise.resolve(response({ ...repository, ...options.settings }));
      }

      if (url.pathname === "/repos/octo/demo/commits/main") {
        return Promise.resolve(
          response(
            options.commitStatus && options.commitStatus !== 200
              ? { message: options.commitMessage ?? "Git Repository is empty" }
              : { sha: headSha },
            options.commitStatus ?? 200,
          ),
        );
      }

      if (
        url.pathname === "/repos/octo/demo/git/trees/main" ||
        url.pathname === `/repos/octo/demo/git/trees/${headSha}`
      ) {
        return Promise.resolve(
          response(
            options.treeStatus && options.treeStatus !== 200
              ? { message: options.treeMessage ?? "Git Repository is empty" }
              : {
                  truncated: false,
                  tree: (options.treePaths ?? []).map((path: string) => ({
                    path,
                    type: "blob",
                    mode: "100644",
                    sha: "c".repeat(40),
                    size: 1,
                  })),
                },
            options.treeStatus ?? 200,
          ),
        );
      }

      if (url.pathname === "/repos/octo/demo/branches/main") {
        return Promise.resolve(
          response({
            name: "main",
            protected: options.protection ?? true,
            commit: { sha: headSha },
          }),
        );
      }

      if (url.pathname === "/repos/octo/demo/branches/main/protection") {
        return Promise.resolve(response({ required_linear_history: true }));
      }

      const contentsPrefix = "/repos/octo/demo/contents/";

      if (url.pathname.startsWith(contentsPrefix)) {
        const path = decodeURIComponent(url.pathname.slice(contentsPrefix.length));
        const item = options.contents?.[path];

        if (item && "error" in item) {
          return Promise.resolve(response({ message: "unreadable" }, item.error));
        }

        const content = item?.content ?? "";

        return Promise.resolve(
          response({
            type: "file",
            encoding: "base64",
            size: item?.size ?? content.length,
            content: btoa(content),
          }),
        );
      }

      return Promise.resolve(response({ message: `Unhandled ${url.pathname}` }, 404));
    },
    { retry: false },
  );

  return { client, calls };
}

describe("filesNeeded", () => {
  it("collects content paths and includes the workflow files marker", () => {
    const paths = filesNeeded([
      practice([
        check({ type: "file-exists", path: "README.md", absent: false }),
        check({ type: "file-matches", path: "src/a.ts", source: "files/src/a.ts" }),
        check({ type: "file-contains", path: "README.md", text: "Shipshape" }),
        check({ type: "json-path", file: "package.json", path: "name", exists: true }),
        check({ type: "yaml-path", file: "config.yml", path: "mode", exists: true }),
        check({ type: "dependency", file: "package.json", name: "zod", version: "4.6.7" }),
        check({ type: "workflow", check: "pinned-actions" }),
      ]),
    ]);

    expect(paths).toEqual(
      expect.arrayContaining(["src/a.ts", "README.md", "package.json", "config.yml"]),
    );
    expect(paths.some((path: string) => path.includes(".github/workflows"))).toBe(true);
  });
});

describe("takeSnapshot API reads", () => {
  it("collects every Wrangler policy input at the captured commit without executing configs", async () => {
    const contents = {
      "packages/worker/package.json": { content: '{"scripts":{"deploy":"wrangler deploy"}}' },
      ".github/workflows/deploy.yaml": {
        content: "jobs:\n  deploy:\n    steps:\n      - run: cf deploy\n",
      },
      "tooling/deploy/action.yaml": {
        content: "runs:\n  using: composite\n  steps:\n    - run: cf deploy\n",
      },
      "cloudflare.config.ts": { content: "throw new Error('never execute')" },
      "pnpm-lock.yaml": { content: "wrangler: transitive" },
      "scripts/deploy.mjs": { content: "throw new Error('never execute')" },
    };

    const fixture = snapshotClient({ treePaths: Object.keys(contents), contents });
    const selected = check({ type: "cloudflare-cf-cli" });
    const snapshot = await takeSnapshot(fixture.client, snapshotRepository, [practice([selected])]);

    expect([...snapshot.files.keys()].toSorted()).toEqual([
      ".github/workflows/deploy.yaml",
      "packages/worker/package.json",
      "tooling/deploy/action.yaml",
    ]);
    expect(runCheck(selected, snapshot, {})).toMatchObject({
      state: "fail",
      path: "packages/worker/package.json",
    });
    expect(
      fixture.calls
        .filter((url) => url.pathname.includes("/contents/"))
        .every((url) => url.searchParams.get("ref") === headSha),
    ).toBe(true);
  });
  it.each(["portless-dev"] as const)(
    "reads only the selected manifest at the captured commit for %s",
    async (type) => {
      const contents = {
        "apps/web/package.json": {
          content: JSON.stringify({
            devDependencies: { portless: "0.15.8", cf: "1.0.0" },
            scripts: { dev: "portless run cf dev" },
          }),
        },
        "apps/web/cloudflare.config.ts": { content: "throw new Error('never execute')" },
        "package.json": { content: "{}" },
      };

      const fixture = snapshotClient({ treePaths: Object.keys(contents), contents });
      const selected = check({ type, directory: "apps/web" });

      const snapshot = await takeSnapshot(fixture.client, snapshotRepository, [
        practice([selected]),
      ]);

      expect([...snapshot.files.keys()]).toEqual(["apps/web/package.json"]);
      expect(runCheck(selected, snapshot, {}).state).toBe("pass");
      expect(
        fixture.calls
          .filter((url) => url.pathname.includes("/contents/"))
          .every((url) => url.searchParams.get("ref") === headSha),
      ).toBe(true);
      expect(fixture.calls.some((url) => url.pathname.includes("/branches/"))).toBe(false);
    },
  );
  it("collects the manifest and CI workflow for the test-script rule at the captured commit", async () => {
    const path = ".github/workflows/ci.yml";

    const fixture = snapshotClient({
      treePaths: ["package.json", path],
      contents: {
        "package.json": { content: '{"scripts":{"test":"vitest run"}}' },
        [path]: { content: "jobs:\n  ci:\n    steps:\n      - run: pnpm test\n" },
      },
    });

    const selected = check({ type: "ci-test-script" });

    const snapshot = await takeSnapshot(fixture.client, snapshotRepository, [practice([selected])]);

    expect(runCheck(selected, snapshot, {}).state).toBe("pass");
    expect([...snapshot.files.keys()].toSorted()).toEqual([path, "package.json"]);
    expect(
      fixture.calls
        .filter((url) => url.pathname.includes("/contents/"))
        .every((url) => url.searchParams.get("ref") === headSha),
    ).toBe(true);
    expect(fixture.calls.some((url) => url.pathname.includes("/branches/"))).toBe(false);
  });

  it.each(["vitest-test-script", "required-package-scripts"] as const)(
    "reads root and nested manifests at the evaluated commit for %s",
    async (type) => {
      const fixture = snapshotClient({
        treePaths: ["package.json", "apps/web/package.json", "fixtures/package.json", "other.json"],
        contents: {
          "package.json": {
            content:
              '{"scripts":{"test":"vitest run","lint":"oxlint","format":"oxfmt","build":"vite build"}}',
          },
          "apps/web/package.json": {
            content:
              '{"scripts":{"test":"vitest","lint":"oxlint","format":"oxfmt","build":"vite build"}}',
          },
          "fixtures/package.json": { content: "{}" },
        },
      });

      const selected = check({ type });

      const snapshot = await takeSnapshot(fixture.client, snapshotRepository, [
        practice([selected]),
      ]);

      expect([...snapshot.files.keys()].toSorted()).toEqual([
        "apps/web/package.json",
        "fixtures/package.json",
        "package.json",
      ]);
      expect(runCheck(selected, snapshot, {})).toMatchObject({
        state: "fail",
        path: "fixtures/package.json",
      });
      expect(
        fixture.calls
          .filter((url) => url.pathname.includes("/contents/"))
          .every((url) => url.searchParams.get("ref") === headSha),
      ).toBe(true);
    },
  );

  it.each(["vitest-test-script", "required-package-scripts", "cloudflare-cf-cli"] as const)(
    "keeps excess manifests unknown within the shared read budget for %s",
    async (type) => {
      const paths = Array.from({ length: 65 }, (_, index) => `packages/p${index}/package.json`);

      const fixture = snapshotClient({
        treePaths: paths,
        contents: Object.fromEntries(
          paths.map((path) => [
            path,
            {
              content:
                '{"scripts":{"test":"vitest run","lint":"oxlint","format":"oxfmt","build":"vite build"}}',
            },
          ]),
        ),
      });

      const selected = check({ type });

      const snapshot = await takeSnapshot(fixture.client, snapshotRepository, [
        practice([selected]),
      ]);

      expect(fixture.calls.filter((url) => url.pathname.includes("/contents/"))).toHaveLength(64);
      expect(runCheck(selected, snapshot, {})).toMatchObject({
        state: "unknown",
        detail: "Read budget exceeded",
      });
    },
  );

  it("reads commit and tree, but conditionally skips settings and protection endpoints", async () => {
    const fixture = snapshotClient({ treePaths: ["README.md"] });

    const snapshot = await takeSnapshot(fixture.client, snapshotRepository, [
      practice([check({ type: "file-exists", path: "README.md", absent: false })]),
    ]);

    expect(snapshot.headSha).toBe(headSha);
    expect(snapshot.tree?.paths).toEqual(new Set(["README.md"]));
    expect(fixture.calls.some((url) => url.pathname === "/repos/octo/demo")).toBe(false);
    expect(fixture.calls.some((url) => url.pathname.includes("/branches/"))).toBe(false);
  });

  it("reads repository settings only when a setting check exists", async () => {
    const fixture = snapshotClient({ settings: { allow_squash_merge: true } });

    const snapshot = await takeSnapshot(fixture.client, snapshotRepository, [
      practice([check({ type: "setting", key: "allow_squash_merge", equals: true })]),
    ]);

    expect(snapshot.settings).toEqual(expect.objectContaining({ allow_squash_merge: true }));
    expect(fixture.calls.filter((url) => url.pathname === "/repos/octo/demo")).toHaveLength(1);
  });

  it("reads branch protection when a branch-protection check exists", async () => {
    const fixture = snapshotClient({ treePaths: [], protection: true });

    const snapshot = await takeSnapshot(fixture.client, snapshotRepository, [
      practice([check({ type: "branch-protection", key: "requiredLinearHistory", equals: true })]),
    ]);

    expect(snapshot.protection.has("main")).toBe(true);
    expect(fixture.calls.some((url) => url.pathname === "/repos/octo/demo/branches/main")).toBe(
      true,
    );
    expect(
      fixture.calls.some((url) => url.pathname === "/repos/octo/demo/branches/main/protection"),
    ).toBe(true);
  });

  it("collects ci.yml at the captured commit and default-branch protection for CI checks", async () => {
    const path = ".github/workflows/ci.yml";
    const content = "jobs:\n  ci:\n    runs-on: ubuntu-latest\n";

    const fixture = snapshotClient({
      treePaths: [path],
      contents: { [path]: { content } },
    });

    const selected = check({ type: "ci-required-checks" });
    const snapshot = await takeSnapshot(fixture.client, snapshotRepository, [practice([selected])]);

    expect(snapshot.files.get(path)).toBe(content);
    expect(snapshot.protection.get("main")?.status).toBe("protected");
    expect(
      fixture.calls
        .find((url) => decodeURIComponent(url.pathname).endsWith(`/contents/${path}`))
        ?.searchParams.get("ref"),
    ).toBe(headSha);
    expect(
      fixture.calls.filter((url) => url.pathname === "/repos/octo/demo/branches/main/protection"),
    ).toHaveLength(1);
    expect(runCheck(selected, snapshot, {}).state).toBe("fail");
  });

  it("turns an empty-repository tree 409 into a null tree with a stable error", async () => {
    const fixture = snapshotClient({ treeStatus: 409 });

    const snapshot = await takeSnapshot(fixture.client, snapshotRepository, [
      practice([check({ type: "file-exists", path: "README.md", absent: false })]),
    ]);

    expect(snapshot.tree).toBeNull();
    expect(snapshot.treeError).toBe("Repository has no commits");
  });

  it("records files beyond the 64-file read budget", async () => {
    const needed = Array.from({ length: 65 }, (_, index) => `docs/${index}.md`);

    const fixture = snapshotClient({
      treePaths: needed,
      contents: Object.fromEntries(needed.map((path) => [path, { content: `file ${path}` }])),
    });

    const practices = needed.map((path, index) =>
      practice([check({ type: "file-contains", path, text: "file" })], `practice-${index}`),
    );

    const snapshot = await takeSnapshot(fixture.client, snapshotRepository, practices);
    expect(snapshot.files.get(needed[0])).toEqual("file docs/0.md");
    expect(snapshot.files.get(needed[64])).toEqual({ error: "Read budget exceeded" });
  });

  it("records a contents blob over 512 KB without reading its body", async () => {
    const fixture = snapshotClient({
      treePaths: ["large.txt"],
      contents: { "large.txt": { content: "", size: 512 * 1024 + 1 } },
    });

    const snapshot = await takeSnapshot(fixture.client, snapshotRepository, [
      practice([check({ type: "file-contains", path: "large.txt", text: "x" })]),
    ]);

    expect(snapshot.files.get("large.txt")).toEqual({ error: "File larger than 512 KB" });
  });

  it("leaves absent complete-tree paths unread so file checks remain definite failures", async () => {
    const fixture = snapshotClient({ treePaths: ["README.md"] });

    const snapshot = await takeSnapshot(fixture.client, snapshotRepository, [
      practice([check({ type: "file-contains", path: "missing.md", text: "x" })]),
    ]);

    expect(snapshot.files.has("missing.md")).toBe(false);

    expect(
      runCheck(check({ type: "file-contains", path: "missing.md", text: "x" }), snapshot, {}),
    ).toMatchObject({ state: "fail" });
  });

  it("keeps a missing practice source unknown before checking an absent target", async () => {
    const fixture = snapshotClient({ treePaths: ["README.md"] });

    const snapshot = await takeSnapshot(fixture.client, snapshotRepository, [
      practice([check({ type: "file-matches", path: "missing.md", source: "files/missing.md" })]),
    ]);

    expect(
      runCheck(
        check({ type: "file-matches", path: "missing.md", source: "files/missing.md" }),
        snapshot,
        {},
      ),
    ).toMatchObject({ state: "unknown" });
  });

  it("continues settings and protection reads when the commit endpoint fails", async () => {
    const fixture = snapshotClient({ commitStatus: 409, settings: { allow_squash_merge: true } });

    const snapshot = await takeSnapshot(fixture.client, snapshotRepository, [
      practice([check({ type: "setting", key: "allow_squash_merge", equals: true })]),
      practice(
        [check({ type: "branch-protection", key: "requiredLinearHistory", equals: true })],
        "protection",
      ),
    ]);

    expect(snapshot.headSha).toBeNull();
    expect(snapshot.tree).toBeNull();
    expect(snapshot.treeError).toBe("Repository has no commits");
    expect(snapshot.settings).toEqual(expect.objectContaining({ allow_squash_merge: true }));
    expect(snapshot.protection.has("main")).toBe(true);
  });
});

describe("semantic lint snapshot collection", () => {
  it("reads package-manager evidence and composite actions at the captured commit", async () => {
    const contents = {
      "package.json": { content: '{"packageManager":"pnpm@12.11.2"}' },
      "apps/web/package.json": { content: "{}" },
      ".github/workflows/ci.yml": { content: "jobs: {}" },
      "tooling/setup/action.yaml": {
        content: "runs:\n  using: composite\n  steps:\n    - uses: pnpm/action-setup@v6\n",
      },
      "scripts/unrelated.js": { content: "throw new Error('never execute')" },
    };

    const { client, calls } = snapshotClient({ treePaths: Object.keys(contents), contents });
    const manager = check({ type: "preferred-package-manager" });
    const setup = check({ type: "pnpm-setup" });
    const snapshot = await takeSnapshot(client, snapshotRepository, [practice([manager, setup])]);

    expect(runCheck(manager, snapshot, {}).state).toBe("pass");
    expect(runCheck(setup, snapshot, {})).toMatchObject({
      state: "fail",
      path: "tooling/setup/action.yaml",
    });
    const reads = calls.filter((url) => url.pathname.includes("/contents/"));
    expect(reads).toHaveLength(4);
    expect(reads.every((url) => url.searchParams.get("ref") === headSha)).toBe(true);
    expect(snapshot.files.has("scripts/unrelated.js")).toBe(false);
  });

  it("reads external lint-staged tasks at the captured commit without executing scripts", async () => {
    const contents = {
      "package.json": {
        content: JSON.stringify({
          devDependencies: { husky: "^9.1.7", "lint-staged": "^17.6.0" },
          scripts: { postinstall: "husky" },
        }),
      },
      ".husky/pre-commit": { content: "npx lint-staged\n" },
      ".lintstagedrc.yml": { content: '"*.ts": oxlint' },
      "scripts/unrelated.js": { content: "throw new Error('never execute')" },
    };

    const { client, calls } = snapshotClient({ treePaths: Object.keys(contents), contents });
    const selected = check({ type: "husky-lint-staged" });
    const snapshot = await takeSnapshot(client, snapshotRepository, [practice([selected])]);

    expect(runCheck(selected, snapshot, {}).state).toBe("pass");
    const reads = calls.filter((url) => url.pathname.includes("/contents/"));
    expect(reads).toHaveLength(3);
    expect(reads.every((url) => url.searchParams.get("ref") === headSha)).toBe(true);
    expect(snapshot.files.has("scripts/unrelated.js")).toBe(false);
  });

  it("reads the formatter and package manifest at the captured commit", async () => {
    const contents = {
      "apps/web/package.json": {
        content: JSON.stringify({ devDependencies: { tailwindcss: "^4.0.0" } }),
      },
      "apps/web/oxfmt.config.ts": {
        content: 'export { default } from "@aranlucas/oxforge/format-tailwind";',
      },
    };

    const { client, calls } = snapshotClient({ treePaths: Object.keys(contents), contents });
    const selected = check({ type: "oxforge-format", directory: "apps/web" });
    const snapshot = await takeSnapshot(client, snapshotRepository, [practice([selected])]);

    expect(runCheck(selected, snapshot, {}).state).toBe("pass");
    const reads = calls.filter((url) => url.pathname.includes("/contents/"));

    expect(reads).toHaveLength(2);
    expect(reads.every((url) => url.searchParams.get("ref") === headSha)).toBe(true);
  });

  it("follows local inherited JSONC at the pinned commit without reading plugin code", async () => {
    const shared = "./node_modules/@aranlucas/oxforge/configs/base.json";

    const contents = {
      "package.json": {
        content: JSON.stringify({ devDependencies: { "@aranlucas/oxforge": "0.2.2" } }),
      },
      ".oxlintrc.json": { content: JSON.stringify({ extends: ["./policy/base.jsonc"] }) },
      "policy/base.jsonc": { content: `{/* shared */ "extends": [".${shared}"]}` },
      "scripts/unrelated.js": { content: "throw new Error('do not execute')" },
    };

    const { client, calls } = snapshotClient({ treePaths: Object.keys(contents), contents });
    const selected = check({ type: "oxforge" });
    const snapshot = await takeSnapshot(client, snapshotRepository, [practice([selected])]);
    expect(runCheck(selected, snapshot, {}).state).toBe("pass");
    const reads = calls.filter((url) => url.pathname.includes("/contents/"));
    expect(reads).toHaveLength(3);
    expect(reads.every((url) => url.searchParams.get("ref") === headSha)).toBe(true);
  });
});

describe("semantic lint read budget", () => {
  it("reports unknown when inherited policy is beyond the shared read budget", async () => {
    const contents: NonNullable<SnapshotClientOptions["contents"]> = {};
    const checks: Check[] = [];

    for (let index = 0; index < 62; index += 1) {
      const path = `checks/${index}.json`;
      contents[path] = { content: "{}" };
      checks.push(check({ type: "file-contains", path, text: "{}" }));
    }

    contents["package.json"] = {
      content: JSON.stringify({ devDependencies: { "@aranlucas/oxforge": "0.2.2" } }),
    };
    contents[".oxlintrc.json"] = { content: JSON.stringify({ extends: ["./policy/base.json"] }) };
    contents["policy/base.json"] = {
      content: JSON.stringify({
        extends: ["../node_modules/@aranlucas/oxforge/configs/base.json"],
      }),
    };
    const { client, calls } = snapshotClient({ treePaths: Object.keys(contents), contents });
    const semantic = check({ type: "oxforge" });

    const snapshot = await takeSnapshot(client, snapshotRepository, [
      practice([...checks, semantic]),
    ]);

    expect(snapshot.files.get("policy/base.json")).toEqual({ error: "Read budget exceeded" });
    expect(runCheck(semantic, snapshot, {}).state).toBe("unknown");
    expect(calls.filter((url) => url.pathname.includes("/contents/"))).toHaveLength(64);
  });
});
