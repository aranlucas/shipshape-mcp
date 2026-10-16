import { ConfigValueSchema, type ConfigValue } from "./config-value";
import type { RepoSnapshot } from "./snapshot";
import { parseYaml } from "./yaml";
import { z } from "zod";

const FileText = z.string();

const FileError = z.object({ error: z.string() });

export type ReadResult<T> =
  | { status: "available"; value: T }
  | { status: "missing" }
  | { status: "unavailable"; detail: string };

/** Only a complete tree can prove a file is missing. */
export function readTextFile(snapshot: RepoSnapshot, path: string): ReadResult<string> {
  const value = snapshot.files.get(path);

  if (value !== undefined) {
    const text = FileText.safeParse(value);

    return text.success
      ? { status: "available", value: text.data }
      : { status: "unavailable", detail: FileError.parse(value).error };
  }

  if (!snapshot.tree || snapshot.tree.truncated || snapshot.tree.paths.has(path)) {
    return {
      status: "unavailable",
      detail: `${path} could not be read at the evaluated commit.`,
    };
  }

  return { status: "missing" };
}

export function readConfigFile(
  snapshot: RepoSnapshot,
  path: string,
  format: "json" | "yaml",
): ReadResult<ConfigValue> {
  const file = readTextFile(snapshot, path);

  if (file.status !== "available") {
    return file;
  }

  try {
    const value =
      format === "json" ? ConfigValueSchema.parse(JSON.parse(file.value)) : parseYaml(file.value);

    return { status: "available", value };
  } catch (error) {
    return {
      status: "unavailable",
      detail: `Could not parse ${path}: ${error instanceof Error ? error.message : `invalid ${format}`}`,
    };
  }
}
