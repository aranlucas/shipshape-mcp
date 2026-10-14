import { z } from "zod";
import type { CheckState } from "../domain/types";
import { configObject } from "./config-value";
import type { StandardsSource } from "./evaluate";
import { inspectLintCommand } from "./lint-command";
import {
  inspectLintConfig,
  joinPath,
  LINT_CONFIG_NAMES,
  parentPath,
  parseConfig,
  resolvePath,
  type LintGraph,
  type TraversalBudget,
} from "./lint-config";

export interface ConvergenceFinding {
  rule: "oxforge-version" | "oxforge-lint" | "oxforge-legacy";
  state: CheckState;
  paths: string[];
  detail: string;
}

function declaredVersions(source: StandardsSource, path: string): string[] | null {
  const manifest = parseConfig(source.files[joinPath(path, "package.json")]);

  if (!manifest) {
    return null;
  }

  const versions: string[] = [];

  for (const name of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const declaration = configObject(manifest[name])["@aranlucas/oxforge"];

    if (declaration !== undefined) {
      const value = z.string().safeParse(declaration).data;

      if (value === undefined) {
        return null;
      }

      versions.push(value);
    }
  }

  return [...new Set(versions)];
}

function versionFinding(
  source: StandardsSource,
  path: string,
  expected: string,
): ConvergenceFinding {
  const versions = declaredVersions(source, path);
  const paths = [joinPath(path, "package.json"), ".shipshape.yml"];
  let state: CheckState = "unknown";

  if (versions?.length === 1) {
    const actual = versions[0];
    state = actual === expected ? "pass" : /^\d+\.\d+\.\d+$/.test(actual) ? "fail" : "unknown";
  } else if (versions?.length === 0) {
    state = source.complete ? "fail" : "unknown";
    let ancestor = path;

    while (ancestor !== ".") {
      ancestor = parentPath(ancestor);
      const manifestPath = joinPath(ancestor, "package.json");

      if (Object.hasOwn(source.files, manifestPath)) {
        const parent = declaredVersions(source, ancestor);

        if (parent?.length !== 0) {
          paths.push(manifestPath);
          state = "unknown";
        }
      }
    }
  }

  return {
    rule: "oxforge-version",
    state,
    paths,
    detail: `Expected @aranlucas/oxforge ${expected}; declared ${versions?.length ? versions.join(", ") : "unavailable or absent"}. Pin the tooling dependency to the policy version. Ranges, conflicting declarations, and workspace provision need verification; installed and locked versions are not verified.`,
  };
}

function entryConfig(
  source: StandardsSource,
  path: string,
  selected: string | null,
  budget: TraversalBudget,
  files: Readonly<StandardsSource["files"]>,
): LintGraph {
  if (selected !== null) {
    const resolved = resolvePath(path, selected);

    return resolved
      ? inspectLintConfig(files, resolved, source.complete, new Set(), budget)
      : { preset: false, uncertain: true, missing: false, legacy: [], paths: [] };
  }

  let directory = path;

  while (true) {
    const currentDirectory = directory;

    const candidates = LINT_CONFIG_NAMES.map((name) => joinPath(currentDirectory, name)).filter(
      (name) => Object.hasOwn(files, name),
    );

    if (candidates.length === 1) {
      const result = inspectLintConfig(files, candidates[0], source.complete, new Set(), budget);
      result.uncertain ||= !source.complete;

      return result;
    }

    if (candidates.length > 1) {
      return { preset: false, uncertain: true, missing: false, legacy: [], paths: candidates };
    }

    if (directory === ".") {
      return {
        preset: false,
        uncertain: !source.complete,
        missing: source.complete,
        legacy: [],
        paths: [joinPath(path, ".oxlintrc.json")],
      };
    }

    directory = parentPath(directory);
  }
}

export function evaluateConvergence(source: StandardsSource, path: string): ConvergenceFinding[] {
  const policy = source.policy.convergence;

  if (!policy) {
    return [];
  }

  const manifestPath = joinPath(path, "package.json");

  if (!Object.hasOwn(source.files, manifestPath)) {
    return (["oxforge-version", "oxforge-lint", "oxforge-legacy"] as const).map((rule) => ({
      rule,
      state: source.complete ? "not_applicable" : "unknown",
      paths: [".shipshape.yml"],
      detail: "Oxforge convergence applies to discovered Node packages only.",
    }));
  }

  const manifest = parseConfig(source.files[manifestPath]);
  const scripts = configObject(manifest?.scripts);

  const lint =
    source.policy.packages.find((pkg) => pkg.path === path)?.commands.lint ??
    z.string().safeParse(scripts.lint).data;

  const command =
    lint === undefined
      ? { configs: [], uncertain: manifest === null }
      : inspectLintCommand(lint, scripts);

  const configFiles = { ...source.files };

  for (const unreadable of source.unreadablePaths ?? []) {
    configFiles[unreadable] = null;
  }

  const budget: TraversalBudget = { remaining: 64 };

  const graphs = command.configs.map((selected) =>
    entryConfig(source, path, selected, budget, configFiles),
  );

  const paths = [manifestPath, ...graphs.flatMap((graph) => graph.paths)];
  const uncertain = command.uncertain || graphs.some((graph) => graph.uncertain);
  const legacy = graphs.flatMap((graph) => graph.legacy);
  const wired = graphs.length > 0 && graphs.every((graph) => graph.preset && !graph.missing);

  return [
    versionFinding(source, path, policy.version),
    {
      rule: "oxforge-lint",
      state: uncertain ? "unknown" : wired ? "pass" : "fail",
      paths,
      detail:
        wired && !uncertain
          ? "The lint command selects a static JSON config extending Oxforge base/recommended. Effective rules, nested overrides, file coverage, installation, and execution are not verified."
          : "Wire lint to oxlint and a JSON extends chain containing Oxforge base/recommended via its node_modules path. Dynamic configs, wrappers, unavailable files, and ambiguous config selection need manual verification.",
    },
    {
      rule: "oxforge-legacy",
      state: legacy.length
        ? "fail"
        : uncertain || !graphs.length || graphs.some((graph) => graph.missing)
          ? "unknown"
          : "pass",
      paths: legacy.length ? legacy : paths,
      detail: legacy.length
        ? "A selected config references a repository-local anti-slop plugin. Compare its behavior with the policy-pinned Oxforge release, migrate shared behavior, and retain stricter local protections until lint, types, tests, and build pass."
        : "No repository-local anti-slop plugin reference was found in the inspected config chain. Published plugins and local rule overrides are allowed; unselected configs and plugin source equivalence are not verified.",
    },
  ];
}
