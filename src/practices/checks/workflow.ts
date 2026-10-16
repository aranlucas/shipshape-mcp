import type { Check } from "../schema";
import type { RepoSnapshot } from "../snapshot";
import { readTextFile } from "../repository-files";
import { inspectWorkflow, type WorkflowInspection } from "../workflows";
import type { CheckOutcome } from "./result";

type WorkflowCheck = Extract<Check, { type: "workflow" }>;

interface WorkflowResult extends WorkflowInspection {
  path: string;
}

export function inspectWorkflows(check: WorkflowCheck, snapshot: RepoSnapshot): CheckOutcome {
  const workflowPaths = snapshot.tree?.paths
    ? [...snapshot.tree.paths]
        .filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path))
        .toSorted()
    : [];

  if (!snapshot.tree) {
    return {
      state: "unknown",
      detail: snapshot.treeError ?? "The repository tree could not be read.",
    };
  }

  if (snapshot.tree.truncated) {
    return { state: "unknown", detail: "The repository tree was truncated." };
  }

  if (!workflowPaths.length) {
    return {
      state: check.check === "dependency-review" ? "fail" : "pass",
      detail: "No workflow files found.",
    };
  }

  const states = workflowPaths.map((path) => {
    const file = readTextFile(snapshot, path);

    if (file.status !== "available") {
      return {
        path,
        state: "unknown",
        detail: file.status === "unavailable" ? file.detail : "Workflow file could not be read.",
      } satisfies WorkflowResult;
    }

    return { path, ...inspectWorkflow(file.value, check.check) };
  });

  const failed = states.find((item) => item.state === false);
  const unknown = states.find((item) => item.state === "unknown");

  if (check.check === "dependency-review") {
    const passed = states.find((item) => item.state === true);

    if (passed) {
      return { state: "pass", path: passed.path };
    }

    if (unknown) {
      return { state: "unknown", path: unknown.path, detail: unknown.detail };
    }
  }

  if (failed) {
    return { state: "fail", path: failed.path, actual: failed.actual, detail: failed.detail };
  }

  if (unknown) {
    return { state: "unknown", path: unknown.path, detail: unknown.detail };
  }

  return { state: "pass", path: workflowPaths[0] };
}
