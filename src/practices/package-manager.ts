import { z } from "zod";
import { ConfigObjectSchema, type ConfigValue } from "./config-value";
import type { CheckOutcome } from "./checks/result";
import { readConfigFile } from "./repository-files";
import type { RepoSnapshot } from "./snapshot";

const Manifest = z.object({
  packageManager: z.string().optional(),
  devEngines: z.object({ packageManager: z.object({ name: z.string() }).optional() }).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
});

const ACTION_FILE = /(?:^|\/)action\.ya?ml$/u;

const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/u;

// Recognizes explicit commands, including common env/exec wrappers and shell lists.
// This is static evidence; arbitrary scripts and computed commands are not executed.
const NPM_COMMAND =
  /^\s*(?:(?:env|command|exec|if|then|do|sudo|cross-env|corepack)\s+|[A-Za-z_]\w*=\S+\s+)*(?:npm|npx|"npm"|"npx"|'npm'|'npx')(?=\s|$)/u;

/** Shell separators inside quoted arguments do not introduce a new command. */
function invokesNpm(source: string): boolean {
  let quote = "";
  let escaped = false;
  let comment = false;
  let command = "";

  for (const character of source) {
    if (comment && character !== "\n") {
      continue;
    }

    comment = false;

    if (escaped) {
      command += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      command += character;

      if (character === quote) {
        quote = "";
      }
    } else if (character === "'" || character === '"' || character === "`") {
      quote = character;
      command += character;
    } else if (character === "#" && (!command || /\s$/u.test(command))) {
      if (NPM_COMMAND.test(command)) {
        return true;
      }

      comment = true;
      command = "";
    } else if (/[;&|()\n\r]/u.test(character)) {
      if (NPM_COMMAND.test(command)) {
        return true;
      }

      command = "";
    } else {
      command += character;
    }
  }

  return NPM_COMMAND.test(command);
}

function manifestPath(path: string): boolean {
  return path === "package.json" || path.endsWith("/package.json");
}

function actionPath(path: string): boolean {
  return ACTION_FILE.test(path) || WORKFLOW_FILE.test(path);
}

function namedStrings(value: ConfigValue, name: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => namedStrings(item, name));
  }

  const object = ConfigObjectSchema.safeParse(value);

  if (!object.success) {
    return [];
  }

  return Object.entries(object.data).flatMap(([key, item]) => {
    const text = z.string().safeParse(item);

    return key === name && text.success ? [text.data] : namedStrings(item, name);
  });
}

function inspectFile(snapshot: RepoSnapshot, path: string, setupOnly: boolean): CheckOutcome {
  const file = readConfigFile(snapshot, path, manifestPath(path) ? "json" : "yaml");

  if (file.status !== "available") {
    return {
      state: "unknown",
      path,
      detail: file.status === "unavailable" ? file.detail : "File could not be read.",
    };
  }

  if (manifestPath(path)) {
    const manifest = Manifest.safeParse(file.value);

    if (!manifest.success) {
      return { state: "unknown", path, detail: "Package manifest has an unsupported shape." };
    }

    const declarations = [
      manifest.data.packageManager?.split("@")[0],
      manifest.data.devEngines?.packageManager?.name,
    ].filter((name) => name !== undefined);

    if (
      declarations.some((name) => name !== "pnpm" && name !== "bun") ||
      (path === "package.json" && !declarations.length)
    ) {
      return { state: "fail", path, detail: "Declare pnpm or Bun as the package manager." };
    }

    const script = Object.entries(manifest.data.scripts ?? {}).find(([, command]) =>
      invokesNpm(command),
    );

    return script
      ? { state: "fail", path, detail: `scripts.${script[0]} invokes npm or npx. Use pnpm or Bun.` }
      : { state: "pass", path };
  }

  const action = ConfigObjectSchema.safeParse(file.value);

  if (!action.success) {
    return { state: "unknown", path, detail: "Workflow or action must be a YAML object." };
  }

  const legacy = namedStrings(action.data, "uses").find((use) =>
    /^pnpm\/action-setup(?:\/[^@]+)?@/iu.test(use),
  );

  if (setupOnly) {
    return legacy
      ? {
          state: "fail",
          path,
          actual: legacy,
          detail: "Replace pnpm/action-setup with pnpm/setup.",
        }
      : { state: "pass", path };
  }

  return namedStrings(file.value, "run").some((command) => invokesNpm(command))
    ? { state: "fail", path, detail: "Workflow or composite action invokes npm or npx." }
    : { state: "pass", path };
}

function inspectPolicy(snapshot: RepoSnapshot, setupOnly: boolean): CheckOutcome {
  if (!snapshot.tree) {
    return { state: "unknown", detail: snapshot.treeError ?? "Repository tree unavailable." };
  }

  const paths = [...snapshot.tree.paths].toSorted();

  const lockfile = !setupOnly
    ? paths.find((path) => /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json)$/u.test(path))
    : undefined;

  if (lockfile) {
    return { state: "fail", path: lockfile, detail: "Replace the npm lockfile with pnpm or Bun." };
  }

  const inspections = paths.flatMap((path) =>
    actionPath(path) || (!setupOnly && manifestPath(path))
      ? [inspectFile(snapshot, path, setupOnly)]
      : [],
  );

  const failure = inspections.find((item) => item.state === "fail");

  if (failure) {
    return failure;
  }

  const unknown = inspections.find((item) => item.state === "unknown");

  if (unknown) {
    return unknown;
  }

  return snapshot.tree.truncated
    ? { state: "unknown", detail: "Repository tree was truncated." }
    : {
        state: "pass",
        detail: "No disallowed package-manager usage found in the inspected files.",
      };
}

export function inspectPackageManager(snapshot: RepoSnapshot): CheckOutcome {
  return inspectPolicy(snapshot, false);
}

export function inspectPnpmSetup(snapshot: RepoSnapshot): CheckOutcome {
  return inspectPolicy(snapshot, true);
}
