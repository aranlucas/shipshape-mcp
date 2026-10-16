import { z } from "zod";
import { ConfigObjectSchema } from "./config-value";
import { readConfigFile } from "./repository-files";
import type { CheckOutcome } from "./checks/result";
import type { RepoSnapshot } from "./snapshot";

export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";

const WorkflowJobs = z.object({ jobs: z.record(z.string(), ConfigObjectSchema) });

const JobName = z.string().min(1).max(255);

/** Compare static job contexts, allowing unrelated required checks to remain enabled. */
export function inspectCiRequiredChecks(snapshot: RepoSnapshot): CheckOutcome {
  const file = readConfigFile(snapshot, CI_WORKFLOW_PATH, "yaml");
  const evidence = { path: CI_WORKFLOW_PATH };

  if (file.status === "missing") {
    return { ...evidence, state: "fail", detail: "The required CI workflow is missing." };
  }

  if (file.status === "unavailable") {
    return { ...evidence, state: "unknown", detail: file.detail };
  }

  const workflow = WorkflowJobs.safeParse(file.value);

  if (!workflow.success) {
    return { ...evidence, state: "unknown", detail: "CI jobs could not be read." };
  }

  const names: string[] = [];

  for (const [id, job] of Object.entries(workflow.data.jobs)) {
    const name = JobName.safeParse(job.name === undefined ? id : job.name);

    // Matrix expansion and reusable workflow calls report runtime-dependent contexts.
    if (
      !name.success ||
      name.data.includes("${{") ||
      Object.hasOwn(job, "strategy") ||
      Object.hasOwn(job, "uses")
    ) {
      return {
        ...evidence,
        state: "unknown",
        detail: `The status check name for CI job ${id} requires review (dynamic name, strategy, or reusable workflow).`,
      };
    }

    names.push(name.data);
  }

  if (!names.length) {
    return { ...evidence, state: "fail", detail: "The CI workflow has no jobs to require." };
  }

  if (new Set(names).size !== names.length) {
    return {
      ...evidence,
      state: "unknown",
      detail: "CI job names are ambiguous; use unique names.",
    };
  }

  const fact = snapshot.protection.get(snapshot.repo.defaultBranch);

  if (!fact || fact.status === "unknown") {
    return {
      ...evidence,
      state: "unknown",
      expected: names,
      detail: fact?.reason ?? "Branch protection was not collected.",
    };
  }

  const actual =
    fact.status === "protected"
      ? (fact.protection.statusChecks?.checks.map((check) => check.context) ?? [])
      : [];

  const missing = names.filter((name) => !actual.includes(name));

  return {
    ...evidence,
    state: missing.length ? "fail" : "pass",
    expected: names,
    actual,
    detail: missing.length
      ? `Require these status checks before merging into ${snapshot.repo.defaultBranch}: ${missing.join(", ")}.`
      : `All CI jobs are required status checks on ${snapshot.repo.defaultBranch}.`,
  };
}
