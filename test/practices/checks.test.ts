import { describe, expect, it } from "vitest";
import { CheckSchema, parsePractice, type Check } from "@/practices/schema";
import { aggregate, runCheck } from "@/practices/checks";
import { makeSnapshot } from "@test/helpers/snapshot";

type CheckInput = Record<string, string | boolean | number | string[] | undefined>;

function asCheck(value: CheckInput): Check {
  return CheckSchema.parse(value);
}

function result(
  check: CheckInput,
  snapshot = makeSnapshot(),
  practiceFiles: Record<string, string> = {},
) {
  return runCheck(asCheck(check), snapshot, practiceFiles);
}

const protectedFact = {
  status: "protected",
  protection: {
    requiredSignatures: false,
    enforceAdmins: true,
    requiredLinearHistory: true,
    allowForcePushes: false,
    allowDeletions: false,
    requiredConversationResolution: true,
    reviews: {
      dismissStaleReviews: true,
      requireCodeOwnerReviews: true,
      requiredApprovingReviews: 1,
      requireLastPushApproval: true,
    },
    statusChecks: { strict: true, checks: [] },
    restricted: false,
  },
} as const;

const workflow = `
name: CI
on:
  pull_request:
permissions:
  contents: read
jobs:
  test:
    permissions:
      contents: read
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567
`;

describe("file-exists checks", () => {
  it("passes when a required path exists", () => {
    expect(
      result(
        { type: "file-exists", path: "README.md", absent: false },
        makeSnapshot({ paths: ["README.md"] }),
      ),
    ).toMatchObject({ state: "pass", path: "README.md" });
  });

  it("passes when an absent path is absent", () => {
    expect(result({ type: "file-exists", path: "README.md", absent: true })).toMatchObject({
      state: "pass",
    });
  });

  it("fails when the required path is missing or an absent path exists", () => {
    expect(result({ type: "file-exists", path: "README.md", absent: false })).toMatchObject({
      state: "fail",
    });
    expect(
      result(
        { type: "file-exists", path: "README.md", absent: true },
        makeSnapshot({ paths: ["README.md"] }),
      ),
    ).toMatchObject({ state: "fail" });
  });

  it("is unknown when a missing path cannot be established", () => {
    expect(
      result(
        { type: "file-exists", path: "README.md", absent: false },
        makeSnapshot({ tree: null }),
      ),
    ).toMatchObject({ state: "unknown" });
    expect(
      result(
        { type: "file-exists", path: "README.md", absent: false },
        makeSnapshot({ truncated: true }),
      ),
    ).toMatchObject({ state: "unknown" });
  });
});

describe("file-matches checks", () => {
  it("normalizes CRLF, trailing spaces, and the final newline before passing", () => {
    const snapshot = makeSnapshot({ files: { "README.md": "one  \r\ntwo\r\n\r\n" } });
    expect(
      result({ type: "file-matches", path: "README.md", source: "files/README.md" }, snapshot, {
        "files/README.md": "one\ntwo\n",
      }),
    ).toMatchObject({ state: "pass" });
  });

  it("fails for different or missing complete-tree content", () => {
    expect(
      result(
        { type: "file-matches", path: "README.md", source: "files/README.md" },
        makeSnapshot({ files: { "README.md": "different" } }),
        { "files/README.md": "expected" },
      ),
    ).toMatchObject({ state: "fail" });
    expect(
      result(
        { type: "file-matches", path: "README.md", source: "files/README.md" },
        makeSnapshot(),
        { "files/README.md": "expected" },
      ),
    ).toMatchObject({ state: "fail" });
  });

  it("compares complete content even when diagnostics share a long preview", () => {
    const prefix = "x".repeat(4096);

    const check = { type: "file-matches", path: "README.md", source: "files/README.md" };

    const output = result(check, makeSnapshot({ files: { "README.md": `${prefix}actual` } }), {
      "files/README.md": `${prefix}expected`,
    });

    expect(output.state).toBe("fail");
    expect(output.expected).toContain("truncated");
    expect(output.actual).toContain("truncated");
    expect(
      new TextEncoder().encode(JSON.stringify(output.expected)).byteLength,
    ).toBeLessThanOrEqual(2048);
    expect(new TextEncoder().encode(JSON.stringify(output.actual)).byteLength).toBeLessThanOrEqual(
      2048,
    );
  });

  it("is unknown for unreadable files and missing practice sources", () => {
    expect(
      result(
        { type: "file-matches", path: "README.md", source: "files/README.md" },
        makeSnapshot({ files: { "README.md": { error: "403" } } }),
        { "files/README.md": "expected" },
      ),
    ).toMatchObject({ state: "unknown", detail: "403" });
    expect(
      result(
        { type: "file-matches", path: "README.md", source: "files/README.md" },
        makeSnapshot({ files: { "README.md": "expected" } }),
      ),
    ).toMatchObject({ state: "unknown", actual: null });
  });
});

describe("file-contains checks", () => {
  it("passes when the substring is present", () => {
    const output = result(
      { type: "file-contains", path: "README.md", text: "Shipshape" },
      makeSnapshot({ files: { "README.md": "Shipshape practices" } }),
    );

    expect(output).toMatchObject({ state: "pass", expected: "Shipshape" });
    expect(output.detail).toBeNull();
  });

  it("fails when the substring or file is absent", () => {
    expect(
      result(
        { type: "file-contains", path: "README.md", text: "Shipshape" },
        makeSnapshot({ files: { "README.md": "other" } }),
      ),
    ).toMatchObject({ state: "fail" });
    expect(result({ type: "file-contains", path: "README.md", text: "Shipshape" })).toMatchObject({
      state: "fail",
    });
  });

  it("is unknown when the file has a read error", () => {
    expect(
      result(
        { type: "file-contains", path: "README.md", text: "Shipshape" },
        makeSnapshot({ files: { "README.md": { error: "rate limited" } } }),
      ),
    ).toMatchObject({ state: "unknown", detail: "rate limited" });
  });
});

describe("json-path checks", () => {
  const check = { type: "json-path", file: "package.json", path: "scripts.lint", equals: "oxlint" };

  it("passes for an equal value and for an existing path", () => {
    const snapshot = makeSnapshot({
      files: { "package.json": '{"scripts":{"lint":"oxlint"},"private":true}' },
    });

    expect(result(check, snapshot)).toMatchObject({
      state: "pass",
      expected: "oxlint",
      actual: "oxlint",
    });
    expect(
      result(
        { type: "json-path", file: "package.json", path: "scripts.lint", exists: true },
        snapshot,
      ),
    ).toMatchObject({ state: "pass" });
  });

  it("fails for a different value or a missing path", () => {
    const snapshot = makeSnapshot({ files: { "package.json": '{"scripts":{"lint":"eslint"}}' } });
    expect(result(check, snapshot)).toMatchObject({ state: "fail" });
    expect(
      result(
        { type: "json-path", file: "package.json", path: "scripts.missing", exists: true },
        snapshot,
      ),
    ).toMatchObject({ state: "fail" });
    expect(result(check)).toMatchObject({ state: "fail" });
  });

  it("is unknown for unreadable and invalid JSON files", () => {
    expect(
      result(check, makeSnapshot({ files: { "package.json": { error: "403" } } })),
    ).toMatchObject({ state: "unknown", detail: "403" });
    expect(result(check, makeSnapshot({ files: { "package.json": "{" } }))).toMatchObject({
      state: "unknown",
    });
  });
});

describe("yaml-path checks", () => {
  const check = {
    type: "yaml-path",
    file: ".github/dependabot.yml",
    path: "updates.0.interval",
    equals: "weekly",
  };

  it("passes for an equal value and for an existing path", () => {
    const snapshot = makeSnapshot({
      files: { ".github/dependabot.yml": "updates:\n  - interval: weekly\n" },
    });

    expect(result(check, snapshot)).toMatchObject({ state: "pass", actual: "weekly" });
    expect(
      result(
        {
          type: "yaml-path",
          file: ".github/dependabot.yml",
          path: "updates.0.interval",
          exists: true,
        },
        snapshot,
      ),
    ).toMatchObject({ state: "pass" });
  });

  it("fails for a different value or a missing path", () => {
    const snapshot = makeSnapshot({
      files: { ".github/dependabot.yml": "updates:\n  - interval: daily\n" },
    });

    expect(result(check, snapshot)).toMatchObject({ state: "fail" });
    expect(
      result(
        {
          type: "yaml-path",
          file: ".github/dependabot.yml",
          path: "updates.0.missing",
          exists: true,
        },
        snapshot,
      ),
    ).toMatchObject({ state: "fail" });
    expect(result(check)).toMatchObject({ state: "fail" });
  });

  it("is unknown for unreadable and invalid YAML files", () => {
    expect(
      result(check, makeSnapshot({ files: { ".github/dependabot.yml": { error: "403" } } })),
    ).toMatchObject({ state: "unknown", detail: "403" });
    expect(
      result(check, makeSnapshot({ files: { ".github/dependabot.yml": "updates: [" } })),
    ).toMatchObject({ state: "unknown" });
  });
});

describe("dependency checks", () => {
  const check = { type: "dependency", file: "package.json", name: "zod", version: "4.6.7" };

  it.each(["0.2.2", "^0.2.2", "~0.2.2", "catalog:", "workspace:*"])(
    "accepts %s when only dependency presence is required",
    (version) => {
      const output = result(
        { type: "dependency", name: "@aranlucas/oxforge" },
        makeSnapshot({
          files: {
            "package.json": JSON.stringify({ devDependencies: { "@aranlucas/oxforge": version } }),
          },
        }),
      );

      expect(output).toMatchObject({
        state: "pass",
        label: "@aranlucas/oxforge declared",
        actual: version,
        detail: null,
      });
    },
  );

  it("fails a presence check for missing or invalid declarations and preserves read errors", () => {
    const presence = { type: "dependency", name: "@aranlucas/oxforge" };

    for (const declaration of [undefined, null, false, 2, "", "  "]) {
      expect(
        result(
          presence,
          makeSnapshot({
            files: {
              "package.json": JSON.stringify({
                dependencies: { "@aranlucas/oxforge": declaration },
              }),
            },
          }),
        ),
      ).toMatchObject({ state: "fail" });
    }

    expect(result(presence)).toMatchObject({ state: "fail" });
    expect(
      result(presence, makeSnapshot({ files: { "package.json": { error: "403" } } })),
    ).toMatchObject({ state: "unknown", detail: "403" });
  });

  it.each(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"])(
    "passes for an exact %s declaration",
    (section) => {
      const snapshot = makeSnapshot({
        files: { "package.json": JSON.stringify({ [section]: { zod: "4.6.7" } }) },
      });

      expect(result(check, snapshot)).toMatchObject({ state: "pass", actual: "4.6.7" });
    },
  );

  it("fails for a different exact version or a missing declaration", () => {
    expect(
      result(
        check,
        makeSnapshot({ files: { "package.json": '{"dependencies":{"zod":"4.6.6"}}' } }),
      ),
    ).toMatchObject({ state: "fail" });
    expect(result(check, makeSnapshot({ files: { "package.json": "{}" } }))).toMatchObject({
      state: "fail",
    });
    expect(result(check)).toMatchObject({ state: "fail" });
  });

  it.each(["^4.6.7", "~4.6.7", "catalog:", "workspace:*"])(
    "returns unknown for non-exact range %s",
    (version) => {
      expect(
        result(
          check,
          makeSnapshot({
            files: { "package.json": JSON.stringify({ dependencies: { zod: version } }) },
          }),
        ),
      ).toMatchObject({ state: "unknown", detail: "Dependency version is not an exact version." });
    },
  );
});

describe("setting checks", () => {
  const check = { type: "setting", key: "merge.allow_squash", equals: true };

  it("passes for an equal dot-path value", () => {
    expect(
      result(check, makeSnapshot({ settings: { merge: { allow_squash: true } } })),
    ).toMatchObject({ state: "pass", expected: "true", actual: "true" });
  });

  it("fails for a different value", () => {
    expect(
      result(check, makeSnapshot({ settings: { merge: { allow_squash: false } } })),
    ).toMatchObject({ state: "fail" });
  });

  it("is unknown for settings read errors and hidden values", () => {
    expect(
      result(check, makeSnapshot({ settings: { error: "GET /repos/octo/demo returned 403" } })),
    ).toMatchObject({ state: "unknown", detail: "GET /repos/octo/demo returned 403" });
    expect(result(check, makeSnapshot({ settings: {} }))).toMatchObject({ state: "unknown" });
  });
});

describe("branch-protection checks", () => {
  it("passes on the default branch and accepts the compatibility alias normalized to canonical form", () => {
    const snapshot = makeSnapshot({ protection: { main: protectedFact } });
    expect(
      result({ type: "branch-protection", key: "requiredLinearHistory", equals: true }, snapshot),
    ).toMatchObject({ state: "pass", actual: "true" });

    const parsed = parsePractice(`
version: 1
id: branch-protection
title: Branch protection
summary: Require linear history.
kind: settings
checks:
  - type: branch-protection
    key: required_linear_history
    equals: true
`);

    expect(parsed.ok).toBe(true);
    expect(parsed).toMatchObject({
      ok: true,
      practice: { checks: [{ key: "requiredLinearHistory" }] },
    });
  });

  it("fails when protection is absent or the fact is unprotected", () => {
    expect(
      result(
        { type: "branch-protection", key: "requiredLinearHistory", equals: true },
        makeSnapshot({
          protection: {
            main: {
              status: "protected",
              protection: { ...protectedFact.protection, requiredLinearHistory: false },
            },
          },
        }),
      ),
    ).toMatchObject({ state: "fail" });
    expect(
      result(
        { type: "branch-protection", key: "requiredLinearHistory", equals: true },
        makeSnapshot({ protection: { main: { status: "unprotected" } } }),
      ),
    ).toMatchObject({ state: "fail" });
  });

  it("is unknown when GitHub cannot read the branch fact", () => {
    expect(
      result(
        { type: "branch-protection", key: "requiredLinearHistory", equals: true },
        makeSnapshot({
          protection: { main: { status: "unknown", reason: "branch could not be read" } },
        }),
      ),
    ).toMatchObject({ state: "unknown", detail: "branch could not be read" });
  });
});

describe("workflow checks", () => {
  const files = { ".github/workflows/ci.yml": workflow };

  it.each(["least-privilege-token", "pinned-actions", "dependency-review"])(
    "passes %s when all workflows satisfy the helper",
    (check) => {
      const contents =
        check === "dependency-review"
          ? workflow.replace("actions/checkout", "actions/dependency-review-action")
          : files[".github/workflows/ci.yml"];

      const output = result(
        { type: "workflow", check },
        makeSnapshot({
          paths: Object.keys(files),
          files: { ".github/workflows/ci.yml": contents },
        }),
      );

      expect(output).toMatchObject({ state: "pass", expected: null, actual: null });
      expect(output.detail).toBeNull();
    },
  );

  it("reports the unpinned Action and its property location", () => {
    const output = result(
      { type: "workflow", check: "pinned-actions" },
      makeSnapshot({
        paths: Object.keys(files),
        files: {
          ".github/workflows/ci.yml": workflow.replace(
            "@0123456789abcdef0123456789abcdef01234567",
            "@v4",
          ),
        },
      }),
    );

    expect(output).toMatchObject({
      state: "fail",
      path: ".github/workflows/ci.yml",
      actual: "actions/checkout@v4",
    });
    expect(output.detail).toContain("jobs.test.steps.0.uses");
  });

  it("requires remote reusable workflows to be pinned too", () => {
    expect(
      result(
        { type: "workflow", check: "pinned-actions" },
        makeSnapshot({
          paths: [".github/workflows/ci.yml"],
          files: {
            ".github/workflows/ci.yml":
              "jobs:\n  ci:\n    uses: octo/shared/.github/workflows/ci.yml@main\n",
          },
        }),
      ),
    ).toMatchObject({ state: "fail", actual: "octo/shared/.github/workflows/ci.yml@main" });
  });

  it("ignores uses keys in action inputs rather than treating them as actions", () => {
    expect(
      result(
        { type: "workflow", check: "pinned-actions" },
        makeSnapshot({
          paths: [".github/workflows/ci.yml"],
          files: {
            ".github/workflows/ci.yml": `${workflow}        with:\n          uses: some-input\n`,
          },
        }),
      ),
    ).toMatchObject({ state: "pass" });
  });

  it("passes dependency review when one workflow provides it and other workflows do not", () => {
    expect(
      result(
        { type: "workflow", check: "dependency-review" },
        makeSnapshot({
          paths: [".github/workflows/ci.yml", ".github/workflows/review.yml"],
          files: {
            ".github/workflows/ci.yml": workflow,
            ".github/workflows/review.yml": workflow.replace(
              "actions/checkout",
              "actions/dependency-review-action",
            ),
          },
        }),
      ),
    ).toMatchObject({ state: "pass", path: ".github/workflows/review.yml" });
  });

  it("keeps dependency review unknown when an unreadable workflow might provide it", () => {
    expect(
      result(
        { type: "workflow", check: "dependency-review" },
        makeSnapshot({
          paths: [".github/workflows/ci.yml", ".github/workflows/review.yml"],
          files: {
            ".github/workflows/ci.yml": workflow,
            ".github/workflows/review.yml": { error: "GitHub returned HTTP 500" },
          },
        }),
      ),
    ).toMatchObject({ state: "unknown", path: ".github/workflows/review.yml" });
  });

  it("is unknown when the tree is unreadable or a workflow cannot be read", () => {
    expect(
      result({ type: "workflow", check: "pinned-actions" }, makeSnapshot({ tree: null })),
    ).toMatchObject({ state: "unknown" });
    expect(
      result(
        { type: "workflow", check: "pinned-actions" },
        makeSnapshot({
          paths: Object.keys(files),
          files: { ".github/workflows/ci.yml": { error: "403" } },
        }),
      ),
    ).toMatchObject({ state: "unknown", detail: "403" });
  });

  it("fails dependency-review when a complete tree has no dependency-review workflow", () => {
    expect(
      result(
        { type: "workflow", check: "dependency-review" },
        makeSnapshot({ paths: ["README.md"] }),
      ),
    ).toMatchObject({ state: "fail" });
  });
});

describe("file availability", () => {
  it.each([
    { type: "file-contains", path: "config.json", text: "enabled" },
    { type: "file-matches", path: "config.json", source: "files/config.json" },
    { type: "json-path", file: "config.json", path: "enabled", equals: true },
    { type: "yaml-path", file: "config.json", path: "enabled", equals: true },
    { type: "dependency", file: "config.json", name: "zod" },
  ])("keeps $type unknown when a tree entry has no collected content", (check) => {
    const sources = { "files/config.json": "{}" };

    expect(result(check, makeSnapshot({ paths: ["config.json"] }), sources)).toMatchObject({
      state: "unknown",
      detail: "config.json could not be read at the evaluated commit.",
    });
    expect(result(check, makeSnapshot(), sources)).toMatchObject({ state: "fail" });
    expect(result(check, makeSnapshot({ truncated: true }), sources)).toMatchObject({
      state: "unknown",
    });
    expect(result(check, makeSnapshot({ tree: null }), sources)).toMatchObject({
      state: "unknown",
    });
  });
});

describe("structured path predicates", () => {
  it.each(["json-path", "yaml-path"])(
    "preserves false, null, arrays and own-property lookup for %s",
    (type) => {
      const snapshot = makeSnapshot({
        files: { "config.json": '{"enabled":false,"empty":null,"items":[{"name":"first"}]}' },
      });

      expect(
        result({ type, file: "config.json", path: "enabled", equals: false }, snapshot),
      ).toMatchObject({ state: "pass", expected: "false", actual: "false" });
      expect(
        result({ type, file: "config.json", path: "empty", exists: true }, snapshot),
      ).toMatchObject({ state: "pass", actual: "null" });
      expect(
        result({ type, file: "config.json", path: "items.0.name", equals: "first" }, snapshot),
      ).toMatchObject({ state: "pass" });
      expect(
        result({ type, file: "config.json", path: "items.length", equals: 1 }, snapshot),
      ).toMatchObject({ state: "pass" });
      expect(
        result({ type, file: "config.json", path: "toString", exists: false }, snapshot),
      ).toMatchObject({ state: "pass" });
      expect(
        result({ type, file: "config.json", path: "items.1", exists: false }, snapshot),
      ).toMatchObject({ state: "pass" });
    },
  );

  it("keeps ambiguous YAML with duplicate keys unknown", () => {
    expect(
      result(
        { type: "yaml-path", file: "config.yml", path: "enabled", equals: true },
        makeSnapshot({ files: { "config.yml": "enabled: false\nenabled: true\n" } }),
      ),
    ).toMatchObject({ state: "unknown" });
  });
});

describe("typed branch protection expectations", () => {
  it.each([
    { expected: 0, state: "fail" },
    { expected: 1, state: "pass" },
    { expected: 2, state: "fail" },
  ])("compares review counts with $expected", ({ expected, state }) => {
    expect(
      result(
        { type: "branch-protection", key: "requiredApprovingReviews", equals: expected },
        makeSnapshot({ protection: { main: protectedFact } }),
      ),
    ).toMatchObject({ state, expected: String(expected), actual: "1" });
  });

  it.each([
    { expected: ["lint", "test"], state: "pass" },
    { expected: ["test", "lint"], state: "pass" },
    { expected: ["test", "lint", "lint"], state: "pass" },
    { expected: ["test"], state: "fail" },
    { expected: ["test", "lint", "build"], state: "fail" },
    { expected: [], state: "fail" },
  ])("compares status-check sets $expected", ({ expected, state }) => {
    const snapshot = makeSnapshot({
      protection: {
        main: {
          ...protectedFact,
          protection: {
            ...protectedFact.protection,
            statusChecks: {
              strict: true,
              checks: [
                { context: "test", appId: null },
                { context: "lint", appId: null },
              ],
            },
          },
        },
      },
    });

    expect(
      result(
        { type: "branch-protection", key: "requiredStatusChecks", equals: expected },
        snapshot,
      ),
    ).toMatchObject({ state, expected: JSON.stringify(expected), actual: '["test","lint"]' });
  });

  it("uses zero reviews and no required checks for unprotected branches", () => {
    const snapshot = makeSnapshot({ protection: { main: { status: "unprotected" } } });

    expect(
      result({ type: "branch-protection", key: "requiredApprovingReviews", equals: 0 }, snapshot),
    ).toMatchObject({ state: "pass", actual: "0" });
    expect(
      result({ type: "branch-protection", key: "requiredStatusChecks", equals: [] }, snapshot),
    ).toMatchObject({ state: "pass", actual: "[]" });
  });

  it("keeps undisclosed protection flags unknown", () => {
    const snapshot = makeSnapshot({
      protection: {
        main: {
          ...protectedFact,
          protection: { ...protectedFact.protection, requiredSignatures: null },
        },
      },
    });

    expect(
      result({ type: "branch-protection", key: "requiredSignatures", equals: true }, snapshot),
    ).toMatchObject({ state: "unknown" });
  });
});

describe("diagnostic formatting", () => {
  it("bounds multibyte evidence and read errors after evaluation", () => {
    const text = "🙂".repeat(4096);
    const check = { type: "file-contains", path: "README.md", text: "Shipshape" };
    const output = result(check, makeSnapshot({ files: { "README.md": text } }));
    const error = result(check, makeSnapshot({ files: { "README.md": { error: text } } }));

    expect(output.state).toBe("fail");
    expect(output.actual).toContain("… [truncated for storage]");
    expect(output.detail).toContain("Diagnostic values were truncated");
    expect(error.state).toBe("unknown");
    expect(error.detail).toContain("… [truncated for storage]");
    expect(new TextEncoder().encode(JSON.stringify(output.actual)).byteLength).toBeLessThanOrEqual(
      2048,
    );
    expect(new TextEncoder().encode(JSON.stringify(error.detail)).byteLength).toBeLessThanOrEqual(
      2048,
    );
  });
});

describe("aggregate", () => {
  const pass = result(
    { type: "file-exists", path: "README.md", absent: false },
    makeSnapshot({ paths: ["README.md"] }),
  );

  const fail = result({ type: "file-exists", path: "README.md", absent: false });

  const unknown = result(
    { type: "file-exists", path: "README.md", absent: false },
    makeSnapshot({ tree: null }),
  );

  it("lets a definite failure dominate unknown", () => {
    expect(aggregate([pass, unknown, fail])).toEqual({ state: "fail", failing: 1, unknown: 1 });
  });

  it("returns unknown when no check fails but one is unknown", () => {
    expect(aggregate([pass, unknown])).toEqual({ state: "unknown", failing: 0, unknown: 1 });
  });

  it("returns pass for an empty defensive input", () => {
    expect(aggregate([])).toEqual({ state: "pass", failing: 0, unknown: 0 });
  });
});
