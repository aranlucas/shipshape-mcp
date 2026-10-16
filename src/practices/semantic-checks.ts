import { z } from "zod";
import type { Check } from "./schema";
import type { RepoSnapshot } from "./snapshot";
import { configObject } from "./config-value";
import { inspectLintConfig, joinPath, LINT_CONFIG_NAMES, parseConfig } from "./lint-config";
import { parseWorkflow } from "./workflows";
import { inspectFormatConfig } from "./format-config";
import { readTextFile } from "./repository-files";

interface Inspection {
  state: "pass" | "fail" | "unknown";
  path: string;
  detail: string;
}

type OxforgeCheck = Extract<Check, { type: "oxforge" }>;

type DependabotCheck = Extract<Check, { type: "dependabot-grouped" }>;

type OxforgeFormatCheck = Extract<Check, { type: "oxforge-format" }>;

export function inspectOxforgeFormat(
  check: OxforgeFormatCheck,
  snapshot: RepoSnapshot,
): Inspection {
  const manifestPath = joinPath(check.directory, "package.json");
  const path = joinPath(check.directory, "oxfmt.config.ts");
  const missing = unavailable(snapshot, manifestPath) ?? unavailable(snapshot, path);

  if (missing) {
    return missing;
  }

  const manifest = parseConfig(z.string().safeParse(snapshot.files.get(manifestPath)).data);

  if (!manifest) {
    return {
      state: "unknown",
      path: manifestPath,
      detail: "The package manifest could not be parsed.",
    };
  }

  const sections = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ].map((section) => z.record(z.string(), z.string()).safeParse(manifest[section] ?? {}));

  if (sections.some((section) => !section.success)) {
    return {
      state: "unknown",
      path: manifestPath,
      detail: "Package dependency declarations could not be parsed.",
    };
  }

  const needsTailwind = sections.some(
    (section) => section.success && Object.hasOwn(section.data, "tailwindcss"),
  );

  const text = z.string().parse(snapshot.files.get(path));

  return { path, ...inspectFormatConfig(text, needsTailwind) };
}

function unavailable(snapshot: RepoSnapshot, path: string): Inspection | null {
  const file = readTextFile(snapshot, path);

  switch (file.status) {
    case "available":
      return null;
    case "missing":
      return { state: "fail", path, detail: "The required file is missing." };
    case "unavailable":
      return { state: "unknown", path, detail: file.detail };
  }
}

function meetsMinimum(version: string, minimum: string): boolean | null {
  // Exact and caret/tilde declarations provide a known lower bound. Catalogs,
  // workspaces, tags, unions and prereleases require resolution, not guessing.
  const match = /^(?:[~^])?(\d+)\.(\d+)\.(\d+)$/.exec(version);

  if (!match) {
    return null;
  }

  const actual = match.slice(1).map(Number);
  const required = minimum.split(".").map(Number);

  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== required[index]) {
      return actual[index] > required[index];
    }
  }

  return true;
}

export function inspectOxforge(check: OxforgeCheck, snapshot: RepoSnapshot): Inspection {
  const manifestPath = joinPath(check.directory, "package.json");
  const missing = unavailable(snapshot, manifestPath);

  if (missing) {
    return missing;
  }

  const manifestText = snapshot.files.get(manifestPath);
  const manifest = parseConfig(z.string().safeParse(manifestText).data);

  if (!manifest) {
    return {
      state: "unknown",
      path: manifestPath,
      detail: "The package manifest could not be parsed.",
    };
  }

  const dependency = z
    .string()
    .safeParse(
      configObject(manifest.devDependencies)["@aranlucas/oxforge"] ??
        configObject(manifest.dependencies)["@aranlucas/oxforge"],
    ).data;

  if (!dependency) {
    return {
      state: "fail",
      path: manifestPath,
      detail: "Declare the shared @aranlucas/oxforge package.",
    };
  }

  const supported = meetsMinimum(dependency, check.minimumVersion);

  if (supported !== true) {
    return {
      state: supported === false ? "fail" : "unknown",
      path: manifestPath,
      detail:
        supported === false
          ? `Oxforge ${dependency} is below ${check.minimumVersion}.`
          : `Resolve ${dependency} before assessing the Oxforge version.`,
    };
  }

  if (!snapshot.tree || snapshot.tree.truncated) {
    return {
      state: "unknown",
      path: manifestPath,
      detail: "The complete lint configuration inventory is unavailable.",
    };
  }

  const candidates = LINT_CONFIG_NAMES.map((name) => joinPath(check.directory, name)).filter(
    (path) => snapshot.tree?.paths.has(path),
  );

  if (candidates.length !== 1) {
    return {
      state: candidates.length ? "unknown" : "fail",
      path: manifestPath,
      detail: candidates.length
        ? "Multiple lint entry points require review of the active lint command."
        : "No supported Oxlint configuration was found; document framework-specific lint exceptions explicitly.",
    };
  }

  const path = candidates[0];

  const files = Object.fromEntries(
    [...snapshot.files].map(([name, value]) => [name, z.string().safeParse(value).data ?? null]),
  );

  // Known-but-unread files must remain uncertain rather than appearing missing.
  for (const name of snapshot.tree.paths) {
    if (!(name in files)) {
      files[name] = null;
    }
  }

  const graph = inspectLintConfig(files, path, true);

  if (graph.legacy.length) {
    return {
      state: "fail",
      path: graph.legacy[0],
      detail:
        "A local anti-slop plugin duplicates the shared policy; use Oxforge's plugin instead.",
    };
  }

  if (graph.uncertain) {
    return {
      state: "unknown",
      path,
      detail:
        "Dynamic, unread, cyclic or unsupported configuration prevents verifying shared lint inheritance.",
    };
  }

  if (graph.missing || !graph.preset) {
    return {
      state: "fail",
      path,
      detail:
        "Inherit Oxforge base or recommended; framework presets alone are additive. Keep approved native/vendor exceptions explicit.",
    };
  }

  return {
    state: "pass",
    path,
    detail:
      "Shared Oxforge base/recommended is inherited with no local anti-slop plugin. Local overrides and lint execution still need review.",
  };
}

export function inspectDependabot(check: DependabotCheck, snapshot: RepoSnapshot): Inspection {
  const missing = unavailable(snapshot, check.path);

  if (missing) {
    return missing;
  }

  const text = snapshot.files.get(check.path);
  const config = parseWorkflow(z.string().safeParse(text).data ?? "");

  if (!config) {
    return { state: "unknown", path: check.path, detail: "Dependabot YAML could not be parsed." };
  }

  const updates = z
    .array(
      z.object({
        "package-ecosystem": z.string(),
        "multi-ecosystem-group": z.string(),
        patterns: z.array(z.string()),
        directory: z.string().startsWith("/").optional(),
        directories: z.array(z.string().startsWith("/")).min(1).optional(),
      }),
    )
    .min(1)
    .safeParse(config.updates);

  if (
    config.version !== 2 ||
    !updates.success ||
    updates.data.some(
      (entry) => (entry.directory === undefined) === (entry.directories === undefined),
    )
  ) {
    return {
      state: "fail",
      path: check.path,
      detail:
        "Use version 2; every update entry needs directory or directories and a shared multi-ecosystem group with explicit patterns.",
    };
  }

  if (
    updates.data.some((entry) => !["npm", "github-actions"].includes(entry["package-ecosystem"]))
  ) {
    return {
      state: "unknown",
      path: check.path,
      detail:
        "This check currently validates npm and GitHub Actions grouping; other ecosystems require review.",
    };
  }

  const groupNames = new Set(updates.data.map((entry) => entry["multi-ecosystem-group"]));
  const groupName = updates.data[0]["multi-ecosystem-group"];
  const group = configObject(configObject(config["multi-ecosystem-groups"])[groupName]);

  const passes =
    groupNames.size === 1 &&
    group["open-pull-requests-limit"] === 1 &&
    updates.data.every((entry) => entry.patterns.includes("*"));

  return {
    state: passes ? "pass" : "fail",
    path: check.path,
    detail: passes
      ? "All configured update entries share one group with a one-PR limit. Security-update PRs may remain separate."
      : 'Use one shared multi-ecosystem group, patterns ["*"] for every update entry, and group open-pull-requests-limit: 1.',
  };
}
