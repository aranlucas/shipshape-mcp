/* oxlint-disable oxc/branches-sharing-code */

import { z } from "zod";
import {
  ConfigObjectSchema,
  ConfigValueSchema,
  configObject as object,
  type ConfigDocument,
  type ConfigValue,
} from "./config-value";
import { parseYaml } from "./yaml";

export type WorkflowCheck = "least-privilege-token" | "pinned-actions" | "dependency-review";

export interface WorkflowInspection {
  readonly state: boolean | "unknown";
  readonly actual?: string;
  readonly detail: string | null;
}

interface WorkflowUse {
  reference: string;
  location: string;
}

function stepUses(value: ConfigValue | undefined, location: string): WorkflowUse[] {
  const steps = z.array(ConfigValueSchema).safeParse(value).data ?? [];

  return steps.flatMap((item, index) => {
    const step = object(item);
    const stepLocation = `${location}.${index}`;
    const reference = z.string().safeParse(step.uses).data;
    const uses = reference ? [{ reference, location: `${stepLocation}.uses` }] : [];

    return [...uses, ...stepUses(step.parallel, `${stepLocation}.parallel`)];
  });
}

function workflowUses(workflow: ConfigDocument): WorkflowUse[] {
  return Object.entries(object(workflow.jobs)).flatMap(([name, value]) => {
    const job = object(value);
    const location = `jobs.${name}`;
    const reference = z.string().safeParse(job.uses).data;
    const uses = reference ? [{ reference, location: `${location}.uses` }] : [];

    return [...uses, ...stepUses(job.steps, `${location}.steps`)];
  });
}

function workflowTriggersPullRequest(workflow: ConfigDocument): boolean {
  const events = workflow.on;

  if (z.literal("pull_request").safeParse(events).success) {
    return true;
  }

  const eventList = z.array(z.string()).safeParse(events).data;

  if (eventList) {
    return eventList.includes("pull_request");
  }

  const eventMap = ConfigObjectSchema.safeParse(events).data;

  return eventMap ? Object.hasOwn(eventMap, "pull_request") : false;
}

function permissionBlocksAreMinimal(workflow: ConfigDocument): boolean {
  const jobs = object(workflow.jobs);
  const blocks: ConfigValue[] = [];
  const workflowHasPermissions = Object.hasOwn(workflow, "permissions");

  if (workflowHasPermissions) {
    blocks.push(workflow.permissions);
  }

  const jobPermissions = Object.values(jobs).map((job) => {
    const permissions = object(job);

    return Object.hasOwn(permissions, "permissions") ? permissions.permissions : undefined;
  });

  if (!workflowHasPermissions) {
    if (!jobPermissions.length || jobPermissions.some((item) => item === undefined)) {
      return false;
    }

    blocks.push(...jobPermissions.filter((item): item is ConfigValue => item !== undefined));
  } else {
    blocks.push(...jobPermissions.filter((item): item is ConfigValue => item !== undefined));
  }

  return blocks.every((block) => {
    const allPermissions = z.enum(["read-all", "write-all"]).safeParse(block).data;

    if (allPermissions) {
      return false;
    }

    const scopes = ConfigObjectSchema.safeParse(block).data;

    return (
      scopes !== undefined &&
      Object.values(scopes).every(
        (permission) => z.enum(["read", "none"]).safeParse(permission).success,
      )
    );
  });
}

function useIsPinned(reference: string): boolean {
  if (reference.startsWith("./") || reference.startsWith("docker://")) {
    return true;
  }

  const separator = reference.lastIndexOf("@");

  return separator >= 0 && /^[a-f0-9]{40}$/iu.test(reference.slice(separator + 1));
}

function actionUsesArePinned(workflow: ConfigDocument): boolean {
  return workflowUses(workflow).every((use) => useIsPinned(use.reference));
}

function hasDependencyReview(workflow: ConfigDocument): boolean {
  return (
    workflowTriggersPullRequest(workflow) &&
    workflowUses(workflow).some((use) =>
      /^actions\/dependency-review-action@/iu.test(use.reference),
    )
  );
}

export function parseWorkflow(content: string): ConfigDocument | null {
  try {
    return ConfigObjectSchema.safeParse(parseYaml(content)).data ?? null;
  } catch {
    return null;
  }
}

export function inspectWorkflow(content: string, check: WorkflowCheck): WorkflowInspection {
  const parsed = parseWorkflow(content);

  if (!parsed) {
    return { state: "unknown", detail: "Workflow could not be parsed." };
  }

  if (check === "pinned-actions") {
    const unpinned = workflowUses(parsed).filter((use) => !useIsPinned(use.reference));

    return unpinned.length
      ? {
          state: false,
          actual: unpinned.map((use) => use.reference).join("\n"),
          detail: `Pin remote Actions and reusable workflows to full commit SHAs: ${unpinned.map((use) => `${use.location}: ${use.reference}`).join("; ")}`,
        }
      : { state: true, detail: null };
  }

  if (check === "least-privilege-token") {
    const state = permissionBlocksAreMinimal(parsed);

    return {
      state,
      detail: state
        ? null
        : "Declare read/none token permissions at workflow or every job level; write scopes and read-all/write-all are not accepted.",
    };
  }

  const state = hasDependencyReview(parsed);

  return {
    state,
    detail: state
      ? null
      : "No dependency-review Action triggered by pull_request was found in this workflow.",
  };
}

export { actionUsesArePinned, hasDependencyReview, permissionBlocksAreMinimal };
