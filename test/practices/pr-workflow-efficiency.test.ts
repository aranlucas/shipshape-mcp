import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { runCheck } from "@/practices/checks";
import { CheckSchema, checkLabel } from "@/practices/schema";
import { makeSnapshot, type SnapshotOptions, type SnapshotValue } from "@test/helpers/snapshot";

const check = CheckSchema.parse({ type: "pr-workflow-efficiency" });

const path = ".github/workflows/check.yml";

const guard = "github.event.pull_request.draft != true";

const events = ["opened", "synchronize", "reopened", "ready_for_review"];

function workflow() {
  return {
    name: "Checks",
    on: { pull_request: { types: events }, push: { branches: ["main"] } },
    concurrency: {
      group: "${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}",
      "cancel-in-progress": true,
    },
    jobs: {
      test: { if: `\${{ ${guard} }}`, "runs-on": "ubuntu-latest", steps: [{ run: "pnpm test" }] },
    },
  };
}

function evaluate(value: SnapshotValue = workflow(), options: SnapshotOptions = {}) {
  return runCheck(
    check,
    makeSnapshot({ paths: [path], files: { [path]: stringify(value) }, ...options }),
    {},
  );
}

describe("PR workflow efficiency", () => {
  it("accepts lifecycle events, stable cancellation and job draft guards", () => {
    expect(evaluate().state).toBe("pass");
    expect(checkLabel(check)).toBe("PR checks cancel superseded runs and skip draft jobs");
    expect(CheckSchema.safeParse({ type: "pr-workflow-efficiency", path }).success).toBe(false);
  });

  it.each<SnapshotValue>([
    "pull_request",
    ["push", "pull_request"],
    { pull_request: null },
    { pull_request: {} },
  ])("requires explicit ready-for-review activity for %j", (on) => {
    const result = evaluate({ ...workflow(), on });

    expect(result).toMatchObject({ state: "fail", path });
    expect(result.detail).toContain("ready_for_review");
    expect(result.detail).not.toContain("converted_to_draft");
  });

  it.each(events)("requires the %s event", (missing) => {
    expect(
      evaluate({
        ...workflow(),
        on: { pull_request: { types: events.filter((event) => event !== missing) } },
      }).state,
    ).toBe("fail");
  });

  it("allows converted_to_draft as an optional existing activity", () => {
    expect(
      evaluate({
        ...workflow(),
        on: { pull_request: { types: [...events, "converted_to_draft"] } },
      }).state,
    ).toBe("pass");
  });

  it("allows additional existing activities and mixed triggers", () => {
    expect(
      evaluate({
        ...workflow(),
        on: {
          ...workflow().on,
          pull_request: { types: [...events, "labeled"] },
          workflow_dispatch: null,
        },
      }).state,
    ).toBe("pass");
  });

  it.each([
    "${{ github.workflow }}-${{ github.ref }}",
    "checks-${{ github.ref }}",
    "checks-${{ github.event.pull_request.number }}",
  ])("accepts stable group %s", (group) => {
    expect(
      evaluate({ ...workflow(), concurrency: { group, "cancel-in-progress": true } }).state,
    ).toBe("pass");
  });

  it.each([
    "${{ github.ref }}",
    "checks",
    "${{ github.workflow }}",
    "checks-${{ github.sha }}",
    "checks-${{ github.run_id }}",
    "checks-${{ github.run_attempt }}",
    "checks-${{ github.event.pull_request.head.sha }}",
  ])("rejects unstable or incomplete group %s", (group) => {
    expect(
      evaluate({ ...workflow(), concurrency: { group, "cancel-in-progress": true } }).state,
    ).toBe("fail");
  });

  it.each<SnapshotValue>([
    null,
    {},
    { group: "checks-${{ github.ref }}" },
    { group: "checks-${{ github.ref }}", "cancel-in-progress": false },
  ])("requires workflow cancellation: %j", (concurrency) => {
    expect(evaluate({ ...workflow(), concurrency }).state).toBe("fail");
  });

  it("accepts cancellation conditional on PR events, but reviews other expressions", () => {
    expect(
      evaluate({
        ...workflow(),
        concurrency: {
          ...workflow().concurrency,
          "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
        },
      }).state,
    ).toBe("pass");
    expect(
      evaluate({
        ...workflow(),
        concurrency: {
          ...workflow().concurrency,
          "cancel-in-progress": "${{ github.event.action != 'converted_to_draft' }}",
        },
      }).state,
    ).toBe("unknown");
    expect(
      evaluate({
        ...workflow(),
        concurrency: { ...workflow().concurrency, group: "checks-${{ inputs.group }}" },
      }).state,
    ).toBe("unknown");
  });

  it.each(["${{ true", "${{ github.event_name == 'pull_ request' }}"])(
    "does not normalize invalid cancellation expressions into passes: %s",
    (cancellation) => {
      expect(
        evaluate({
          ...workflow(),
          concurrency: {
            ...workflow().concurrency,
            "cancel-in-progress": cancellation,
          },
        }).state,
      ).toBe("unknown");
    },
  );

  it.each([
    guard,
    `always() && (${guard})`,
    `(${guard}) && (needs.test.result == 'success' || github.event_name == 'push')`,
    `(${guard} && success()) || (!github.event.pull_request.draft && failure())`,
    "!github.event.pull_request.draft",
    "github.event.pull_request.draft == false",
  ])("accepts mandatory job guard %s", (condition) => {
    expect(
      evaluate({ ...workflow(), jobs: { test: { ...workflow().jobs.test, if: condition } } }).state,
    ).toBe("pass");
  });

  it.each([`${guard} || always()`, `always() || ${guard}`, "always()", true])(
    "rejects a missing or bypassed guard %s",
    (condition) => {
      expect(
        evaluate({ ...workflow(), jobs: { test: { ...workflow().jobs.test, if: condition } } })
          .state,
      ).toBe("fail");
    },
  );

  it.each([
    `!(${guard})`,
    `contains('${guard}', 'true')`,
    `(${guard}`,
    "github['event']['pull_request']['draft'] != true",
  ])("reviews unsupported guard %s", (condition) => {
    expect(
      evaluate({ ...workflow(), jobs: { test: { ...workflow().jobs.test, if: condition } } }).state,
    ).toBe("unknown");
  });

  it("does not accept step guards or unguarded aggregate and reusable jobs", () => {
    expect(
      evaluate({
        ...workflow(),
        jobs: { test: { "runs-on": "ubuntu-latest", steps: [{ if: guard, run: "pnpm test" }] } },
      }).state,
    ).toBe("fail");
    expect(
      evaluate({
        ...workflow(),
        jobs: {
          ...workflow().jobs,
          aggregate: { if: "always()", needs: ["test"], "runs-on": "ubuntu-latest", steps: [] },
        },
      }).state,
    ).toBe("fail");
    expect(
      evaluate({ ...workflow(), jobs: { reuse: { uses: "./.github/workflows/reuse.yml" } } }).state,
    ).toBe("fail");
  });

  it("reviews guarded reusable workflows, job concurrency and path-filter cleanup", () => {
    expect(
      evaluate({
        ...workflow(),
        jobs: { reuse: { if: guard, uses: "org/repo/.github/workflows/check.yml@main" } },
      }).state,
    ).toBe("unknown");
    expect(
      evaluate({
        ...workflow(),
        jobs: { test: { ...workflow().jobs.test, concurrency: "job-${{ github.ref }}" } },
      }).state,
    ).toBe("unknown");
    expect(
      evaluate({ ...workflow(), on: { pull_request: { types: events, paths: ["src/**"] } } }).state,
    ).toBe("unknown");
    expect(
      evaluate({
        ...workflow(),
        on: { pull_request: { types: events, "paths-ignore": ["docs/**"] } },
      }).state,
    ).toBe("unknown");
  });

  it.each(["${{ github.workflow }}-${{ github.ref }}", "checks-${{ github.ref }}"])(
    "detects colliding group %s across workflows",
    (group) => {
      const other = ".github/workflows/other.yaml";

      const content = stringify({
        ...workflow(),
        concurrency: { group, "cancel-in-progress": true },
      });

      const result = evaluate(workflow(), {
        paths: [path, other],
        files: { [path]: content, [other]: content },
      });

      expect(result.state).toBe("fail");
      expect(result.detail).toContain("collides");
    },
  );

  it("recognizes equivalent PR-number concurrency groups and distinct workflow names", () => {
    const other = ".github/workflows/other.yml";
    const content = workflow();

    const collision = {
      ...workflow(),
      concurrency: {
        group: "${{ github.workflow }}-${{ github.event.pull_request.number }}",
        "cancel-in-progress": true,
      },
    };

    expect(
      evaluate(content, {
        paths: [path, other],
        files: { [path]: stringify(content), [other]: stringify(collision) },
      }).state,
    ).toBe("fail");
    expect(
      evaluate(content, {
        paths: [path, other],
        files: {
          [path]: stringify(content),
          [other]: stringify({ ...collision, name: "Other checks" }),
        },
      }).state,
    ).toBe("pass");
  });

  it.each<SnapshotValue>([null, [], {}, 42, ["push", {}]])(
    "reviews malformed workflow triggers: %j",
    (on) => {
      expect(evaluate({ ...workflow(), on }).state).toBe("unknown");
    },
  );

  it("bounds guard nesting and reviews incomplete logical expressions", () => {
    for (const condition of [`${guard} &&`, `${"(".repeat(40)}${guard}${")".repeat(40)}`]) {
      expect(
        evaluate({ ...workflow(), jobs: { test: { ...workflow().jobs.test, if: condition } } })
          .state,
      ).toBe("unknown");
    }
  });

  it.each<SnapshotOptions["files"]>([
    {},
    { [path]: { error: "HTTP 403" } },
    { [path]: { error: "Read budget exceeded" } },
    { [path]: "jobs: [" },
    { [path]: "null" },
  ])("preserves unknown evidence %j", (files) => {
    expect(evaluate(workflow(), { files }).state).toBe("unknown");
  });

  it("preserves incomplete inventories while known violations still fail", () => {
    expect(evaluate(workflow(), { tree: null }).state).toBe("unknown");
    expect(evaluate(workflow(), { truncated: true }).state).toBe("unknown");
    expect(
      evaluate({ ...workflow(), jobs: { test: { steps: [] } } }, { truncated: true }).state,
    ).toBe("fail");
    expect(
      evaluate(workflow(), {
        paths: [path, ".github/workflows/z.yml"],
        files: {
          [path]: { error: "HTTP 403" },
          ".github/workflows/z.yml": stringify({ ...workflow(), jobs: { test: {} } }),
        },
      }).state,
    ).toBe("fail");
  });

  it("passes complete inventories without pull_request workflows", () => {
    expect(runCheck(check, makeSnapshot(), {}).state).toBe("pass");
    expect(evaluate({ on: ["push", "workflow_call"], jobs: {} }).state).toBe("pass");
  });
});
