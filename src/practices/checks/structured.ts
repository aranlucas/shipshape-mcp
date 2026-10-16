import { z } from "zod";
import { configObject, locateConfigValue } from "../config-value";
import { readConfigFile } from "../repository-files";
import type { Check } from "../schema";
import type { RepoSnapshot } from "../snapshot";
import type { CheckOutcome } from "./result";

type PathCheck = Extract<Check, { type: "json-path" | "yaml-path" }>;

type DependencyCheck = Extract<Check, { type: "dependency" }>;

export function inspectPath(check: PathCheck, snapshot: RepoSnapshot): CheckOutcome {
  const parsed = readConfigFile(snapshot, check.file, check.type === "json-path" ? "json" : "yaml");

  switch (parsed.status) {
    case "missing":
      return { state: "fail", path: check.file };
    case "unavailable":
      return { state: "unknown", path: check.file, detail: parsed.detail };
    case "available": {
      const located = locateConfigValue(parsed.value, check.path);
      const predicate = check.predicate;

      const passes =
        predicate.kind === "equals"
          ? located.present && located.value === predicate.value
          : located.present === predicate.value;

      return {
        state: passes ? "pass" : "fail",
        path: check.file,
        expected: predicate.value,
        actual: located.present ? located.value : undefined,
      };
    }
  }
}

export function inspectDependency(check: DependencyCheck, snapshot: RepoSnapshot): CheckOutcome {
  const parsed = readConfigFile(snapshot, check.file, "json");

  if (parsed.status !== "available") {
    return {
      state: parsed.status === "missing" ? "fail" : "unknown",
      path: check.file,
      detail: parsed.status === "unavailable" ? parsed.detail : null,
    };
  }

  const manifest = configObject(parsed.value);
  const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

  const declarations = sections.flatMap((section) => {
    const value = z
      .string()
      .refine((version) => version.trim().length > 0)
      .safeParse(configObject(manifest[section])[check.name]);

    return value.success ? [value.data] : [];
  });

  const actual = declarations.find((version) => version === check.version) ?? declarations[0];

  if (actual === undefined) {
    return { state: "fail", path: check.file, expected: check.version };
  }

  if (check.version === undefined) {
    return { state: "pass", path: check.file, actual };
  }

  if (/^(?:[~^]|catalog:|workspace:)/u.test(actual)) {
    return {
      state: "unknown",
      path: check.file,
      expected: check.version,
      actual,
      detail: "Dependency version is not an exact version.",
    };
  }

  return {
    state: actual === check.version ? "pass" : "fail",
    path: check.file,
    expected: check.version,
    actual,
  };
}
