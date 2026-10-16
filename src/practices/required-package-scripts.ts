import { z } from "zod";
import { ConfigObjectSchema, type ConfigValue } from "./config-value";
import { readConfigFile } from "./repository-files";
import type { CheckOutcome } from "./checks/result";
import type { RepoSnapshot } from "./snapshot";

const REQUIRED_SCRIPTS = ["lint", "format", "build"] as const;

const Command = z.string().trim().min(1);

// Reject obvious placeholders; this does not interpret arbitrary shell programs.
const PLACEHOLDER =
  /^(?:(?:echo|printf)(?:\s+[\w\s.,:!/?'"=-]+)?|true|false|:|(?:exit|return)(?:\s+\d+)?)$/u;

function usableCommand(value: ConfigValue | undefined): boolean {
  const command = Command.safeParse(value);

  if (!command.success) {
    return false;
  }

  const lines = command.data
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  return lines.length > 0 && !(lines.length === 1 && PLACEHOLDER.test(lines[0]));
}

function inspectManifest(snapshot: RepoSnapshot, path: string): CheckOutcome {
  const file = readConfigFile(snapshot, path, "json");

  if (file.status !== "available") {
    return {
      state: "unknown",
      path,
      detail: file.status === "unavailable" ? file.detail : `${path} could not be read.`,
    };
  }

  const manifest = ConfigObjectSchema.safeParse(file.value);

  if (!manifest.success) {
    return { state: "unknown", path, detail: "Package manifest must be a JSON object." };
  }

  const scripts = ConfigObjectSchema.safeParse(manifest.data.scripts).data;
  const missing = REQUIRED_SCRIPTS.filter((name) => !usableCommand(scripts?.[name]));

  return missing.length
    ? {
        state: "fail",
        path,
        detail: `Declare non-empty scripts with real commands for: ${missing.join(", ")}.`,
      }
    : { state: "pass", path };
}

export function inspectRequiredPackageScripts(snapshot: RepoSnapshot): CheckOutcome {
  if (!snapshot.tree) {
    return { state: "unknown", detail: snapshot.treeError ?? "Repository tree unavailable." };
  }

  const paths = [...snapshot.tree.paths]
    .filter((path) => path === "package.json" || path.endsWith("/package.json"))
    .toSorted();

  const inspections = paths.map((path) => inspectManifest(snapshot, path));
  const failure = inspections.find((inspection) => inspection.state === "fail");

  if (failure) {
    return failure;
  }

  const unknown = inspections.find((inspection) => inspection.state === "unknown");

  if (unknown) {
    return unknown;
  }

  return snapshot.tree.truncated
    ? { state: "unknown", detail: "The repository tree was truncated." }
    : {
        state: "pass",
        detail: paths.length
          ? `All ${paths.length} tracked package.json files declare lint, format, and build scripts.`
          : "No tracked package.json files found.",
      };
}
