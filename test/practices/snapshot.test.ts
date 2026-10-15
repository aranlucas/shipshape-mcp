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

  it("reads branch protection only when a branch-protection check exists", async () => {
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
