import { z } from "zod";
import type { RepoSnapshot } from "./snapshot";
import { inspectCommand } from "./hook-command";
import { parseYaml } from "./yaml";

const Commands = z.union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)]);

const Manifest = z.object({
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  "lint-staged": z.record(z.string().min(1), Commands).optional(),
});

export const LINT_STAGED_CONFIG_NAMES = [
  ".lintstagedrc",
  ".lintstagedrc.json",
  ".lintstagedrc.yaml",
  ".lintstagedrc.yml",
  ...["js", "cjs", "mjs", "ts", "cts", "mts"].flatMap((extension) => [
    `.lintstagedrc.${extension}`,
    `lint-staged.config.${extension}`,
  ]),
];

interface Inspection {
  state: "pass" | "fail" | "unknown";
  path: string;
  detail: string;
}

type FileRead = { text: string } | { inspection: Inspection };

function readFile(snapshot: RepoSnapshot, path: string): FileRead {
  const value = snapshot.files.get(path);
  const content = z.string().safeParse(value);

  if (content.success) {
    return { text: content.data };
  }

  const error = z.object({ error: z.string() }).safeParse(value);

  if (error.success) {
    return { inspection: { state: "unknown", path, detail: error.data.error } };
  }

  const unavailable = !snapshot.tree || snapshot.tree.truncated || snapshot.tree.paths.has(path);

  return {
    inspection: {
      state: unavailable ? "unknown" : "fail",
      path,
      detail: unavailable
        ? `${path} could not be read at the evaluated commit.`
        : `${path} is missing.`,
    },
  };
}

function inspectHook(hook: string, scripts: Readonly<Record<string, string>>): Inspection {
  const invocation = inspectCommand(hook, "lint-staged", scripts, true);

  return {
    state: invocation === "invoked" ? "pass" : invocation === "absent" ? "fail" : "unknown",
    path: ".husky/pre-commit",
    detail:
      invocation === "invoked"
        ? "The hook invokes lint-staged and preserves its failure status."
        : "No lint-staged invocation was proven. Custom shell, wrappers, selectors and flags require review.",
  };
}

function inspectTasks(
  snapshot: RepoSnapshot,
  inline: z.infer<typeof Manifest>["lint-staged"],
): Inspection | null {
  const candidates = LINT_STAGED_CONFIG_NAMES.filter((path) => snapshot.tree?.paths.has(path));

  if (
    !snapshot.tree ||
    snapshot.tree.truncated ||
    candidates.length > 1 ||
    (inline !== undefined && candidates.length > 0)
  ) {
    return {
      state: "unknown",
      path: "package.json",
      detail: "The lint-staged configuration inventory is incomplete or ambiguous.",
    };
  }

  if (inline !== undefined) {
    return Object.keys(inline).length
      ? null
      : { state: "fail", path: "package.json", detail: "Configure nonempty lint-staged tasks." };
  }

  const path = candidates[0];

  if (!path) {
    return {
      state: "fail",
      path: "package.json",
      detail: "Provide lint-staged tasks in package.json or a supported configuration file.",
    };
  }

  const file = readFile(snapshot, path);

  if ("inspection" in file) {
    return file.inspection;
  }

  if (/\.[cm]?[jt]s$/u.test(path)) {
    return {
      state: "unknown",
      path,
      detail: "Code-based lint-staged tasks require review; repository code is never executed.",
    };
  }

  try {
    const value = path.endsWith(".json")
      ? z.json().parse(JSON.parse(file.text))
      : parseYaml(file.text);

    const tasks = z.record(z.string().min(1), Commands).safeParse(value);

    if (!tasks.success || !Object.keys(tasks.data).length) {
      return {
        state: "fail",
        path,
        detail: "Configure a nonempty lint-staged pattern-to-command mapping.",
      };
    }
  } catch {
    return {
      state: "unknown",
      path,
      detail: "The lint-staged task configuration could not be parsed.",
    };
  }

  return null;
}

export function inspectLintStaged(snapshot: RepoSnapshot): Inspection {
  const path = "package.json";
  const file = readFile(snapshot, path);

  if ("inspection" in file) {
    return file.inspection;
  }

  let parsed: ReturnType<typeof Manifest.safeParse>;

  try {
    parsed = Manifest.safeParse(JSON.parse(file.text));
  } catch {
    return { state: "unknown", path, detail: "package.json could not be parsed." };
  }

  if (!parsed.success) {
    return {
      state: "fail",
      path,
      detail: "Husky scripts, dependencies, or lint-staged tasks have an invalid manifest shape.",
    };
  }

  const manifest = parsed.data;

  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
  };

  if (!["husky", "lint-staged"].every((name) => dependencies[name]?.trim())) {
    return {
      state: "fail",
      path,
      detail: "Declare both husky and lint-staged as local dependencies.",
    };
  }

  const scripts = manifest.scripts ?? {};
  const installers = [scripts.prepare, scripts.postinstall].filter((script) => script?.trim());

  if (!installers.some((script) => inspectCommand(script, "husky", scripts) === "invoked")) {
    return {
      state: installers.length ? "unknown" : "fail",
      path,
      detail: "Initialize Husky through prepare or postinstall. Custom installers require review.",
    };
  }

  const tasks = inspectTasks(snapshot, manifest["lint-staged"]);

  if (tasks) {
    return tasks;
  }

  const hook = readFile(snapshot, ".husky/pre-commit");

  if ("inspection" in hook) {
    return hook.inspection;
  }

  const inspection = inspectHook(hook.text, scripts);

  return inspection.state === "pass"
    ? {
        ...inspection,
        detail:
          "Husky initialization, declared dependencies, staged tasks, and a failure-preserving hook invocation are present. Commands were not executed.",
      }
    : inspection;
}
