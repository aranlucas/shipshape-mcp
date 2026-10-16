import { z } from "zod";
import { CI_WORKFLOW_PATH } from "./ci-required-checks";
import { ConfigObjectSchema, type ConfigDocument, type ConfigValue } from "./config-value";
import { readConfigFile } from "./repository-files";
import type { CheckOutcome } from "./checks/result";
import type { RepoSnapshot } from "./snapshot";

const Manifest = z.object({ scripts: z.record(z.string(), z.string()).default({}) });

const Workflow = z.object({ jobs: z.record(z.string(), ConfigObjectSchema) });

type Invocation = "invoked" | "absent" | "unknown";

/** Resolve simple package-script aliases without evaluating repository code. */
function invokesTest(
  source: string,
  scripts: Readonly<Record<string, string>>,
  visited: string[] = [],
): Invocation {
  const lines = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  if (!lines.length) {
    return "absent";
  }

  if (lines.length > 1) {
    return "unknown";
  }

  const command = (lines[0] ?? "").replaceAll(/\s+/gu, " ");
  const call = /^(?:pnpm|npm|yarn|bun) (?:run )?([\w:.-]+)$/u.exec(command);
  const name = call?.[1];

  if (!name) {
    return /^[\w ./:=-]+$/u.test(command) && !/^(?:pnpm|npm|yarn|bun)\b/u.test(command)
      ? "absent"
      : "unknown";
  }

  if (name === "test") {
    return "invoked";
  }

  if (!Object.hasOwn(scripts, name)) {
    return "absent";
  }

  if (visited.includes(name) || visited.length >= 8) {
    return "unknown";
  }

  return invokesTest(scripts[name], scripts, [...visited, name]);
}

function rootDirectory(value: ConfigValue | undefined): boolean {
  return value === undefined || value === "." || value === "./";
}

function stepInvocations(
  value: ConfigValue | undefined,
  scripts: Readonly<Record<string, string>>,
  uncertain: boolean,
  inheritedDirectory: ConfigValue | undefined,
): Invocation[] {
  const steps = z.array(ConfigObjectSchema).safeParse(value);

  if (!steps.success) {
    return ["unknown"];
  }

  return steps.data.flatMap((step) => {
    const guarded = uncertain || Object.hasOwn(step, "if") || Boolean(step["continue-on-error"]);

    if (Object.hasOwn(step, "parallel")) {
      return stepInvocations(step.parallel, scripts, guarded, inheritedDirectory);
    }

    const run = z.string().safeParse(step.run);

    if (!run.success) {
      // Action names are not evidence that the package script is invoked.
      return ["absent"];
    }

    const invocation = invokesTest(run.data, scripts);
    const directory = step["working-directory"] ?? inheritedDirectory;

    return [
      invocation === "invoked" && (guarded || !rootDirectory(directory)) ? "unknown" : invocation,
    ];
  });
}

function defaultDirectory(config: ConfigDocument): ConfigValue | undefined {
  const defaults = ConfigObjectSchema.safeParse(config.defaults).data;
  const run = ConfigObjectSchema.safeParse(defaults?.run).data;

  return run?.["working-directory"];
}

export function inspectCiTestScript(snapshot: RepoSnapshot): CheckOutcome {
  const manifestFile = readConfigFile(snapshot, "package.json", "json");

  if (manifestFile.status !== "available") {
    return {
      state: manifestFile.status === "missing" ? "fail" : "unknown",
      path: "package.json",
      detail:
        manifestFile.status === "missing" ? "Declare a package test script." : manifestFile.detail,
    };
  }

  const manifest = Manifest.safeParse(manifestFile.value);

  if (!manifest.success) {
    return { state: "unknown", path: "package.json", detail: "Package scripts could not be read." };
  }

  if (!manifest.data.scripts.test?.trim()) {
    return {
      state: "fail",
      path: "package.json",
      detail: "Declare a non-empty scripts.test and run it in ci.yml.",
    };
  }

  const file = readConfigFile(snapshot, CI_WORKFLOW_PATH, "yaml");
  const evidence = { path: CI_WORKFLOW_PATH };

  if (file.status !== "available") {
    return {
      ...evidence,
      state: file.status === "missing" ? "fail" : "unknown",
      detail: file.status === "missing" ? "The required CI workflow is missing." : file.detail,
    };
  }

  const workflow = Workflow.safeParse(file.value);

  if (!workflow.success) {
    return { ...evidence, state: "unknown", detail: "CI jobs could not be read." };
  }

  const root = ConfigObjectSchema.parse(file.value);

  const invocations = new Set(
    Object.values(workflow.data.jobs).flatMap((job) =>
      stepInvocations(
        job.steps,
        manifest.data.scripts,
        Object.hasOwn(job, "if") ||
          Boolean(job["continue-on-error"]) ||
          Object.hasOwn(job, "strategy"),
        defaultDirectory(job) ?? defaultDirectory(root),
      ),
    ),
  );

  if (invocations.has("invoked")) {
    return {
      ...evidence,
      state: "pass",
      detail: "ci.yml invokes the declared package test script.",
    };
  }

  return invocations.has("unknown")
    ? {
        ...evidence,
        state: "unknown",
        detail:
          "A test-script invocation could not be proven. Review indirect commands, conditions, directories, or reusable workflows.",
      }
    : {
        ...evidence,
        state: "fail",
        detail: "Run the package test script in ci.yml, for example: pnpm test.",
      };
}
