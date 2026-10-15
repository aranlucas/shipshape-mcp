/* oxlint-disable oxc/branches-sharing-code */

import { z } from "zod";
import {
  ConfigObjectSchema,
  ConfigValueSchema,
  configObject as object,
  type ConfigDocument,
  type ConfigValue,
} from "../standards/config-value";
import { parseYaml } from "../standards/policy";

export type WorkflowCheck = "least-privilege-token" | "pinned-actions" | "dependency-review";

export interface WorkflowInspection {
  readonly parsed: ConfigDocument | null;
  readonly path: string;
}

function workflowUses(value: ConfigValue | undefined, uses: string[] = []): string[] {
  const list = z.array(ConfigValueSchema).safeParse(value).data;

  if (list) {
    for (const item of list) {
      workflowUses(item, uses);
    }

    return uses;
  }

  const record = ConfigObjectSchema.safeParse(value).data;

  if (!record) {
    return uses;
  }

  for (const [key, child] of Object.entries(record)) {
    const use = z.string().safeParse(child).data;

    if (key === "uses" && use) {
      uses.push(use);
    } else {
      workflowUses(child, uses);
    }
  }

  return uses;
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

function actionUsesArePinned(workflow: ConfigDocument): boolean {
  return workflowUses(workflow).every((use) => {
    if (use.startsWith("./") || use.startsWith("docker://")) {
      return true;
    }

    if (/\.github\/workflows\/[^/]+\.ya?ml@[^@]+$/iu.test(use)) {
      return true;
    }

    const separator = use.lastIndexOf("@");

    return separator >= 0 && /^[a-f0-9]{40}$/iu.test(use.slice(separator + 1));
  });
}

function hasDependencyReview(workflow: ConfigDocument): boolean {
  return (
    workflowTriggersPullRequest(workflow) &&
    workflowUses(workflow).some((use) => /^actions\/dependency-review-action@/iu.test(use))
  );
}

export function parseWorkflow(content: string): ConfigDocument | null {
  try {
    return ConfigObjectSchema.safeParse(parseYaml(content)).data ?? null;
  } catch {
    return null;
  }
}

export function inspectWorkflow(content: string, check: WorkflowCheck): boolean | "unknown" {
  const parsed = parseWorkflow(content);

  if (!parsed) {
    return "unknown";
  }

  if (check === "least-privilege-token") {
    return permissionBlocksAreMinimal(parsed);
  }

  if (check === "pinned-actions") {
    return actionUsesArePinned(parsed);
  }

  return hasDependencyReview(parsed);
}

export { actionUsesArePinned, hasDependencyReview, permissionBlocksAreMinimal };
