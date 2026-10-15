/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, oxforge/no-inline-types, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/require-readable-spacing, typescript/prefer-nullish-coalescing */

import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { CheckResult, PracticeState } from "../api/contract";
import type { BranchProtectionFact, ProtectionState } from "./protection";
import { checkLabel, type Check } from "./schema";
import type { RepoSnapshot } from "./snapshot";
import { inspectWorkflow } from "./workflows";

type ReadableFile = string | { error: string };
type ParseFailure = { ok: false; detail: string; missing: boolean };
type ParseResult = { ok: true; value: unknown } | ParseFailure;

function stringified(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  const serialized = JSON.stringify(value);

  return serialized === undefined ? null : serialized;
}

function result(
  check: Check,
  state: "pass" | "fail" | "unknown",
  options: {
    path?: string | null;
    expected?: unknown;
    actual?: unknown;
    detail?: string | null;
  } = {},
): CheckResult {
  return {
    type: check.type,
    label: checkLabel(check),
    state,
    path: options.path ?? null,
    expected: options.expected === undefined ? null : stringified(options.expected),
    actual: options.actual === undefined ? null : stringified(options.actual),
    detail: options.detail ?? null,
  };
}

function fileValue(snapshot: RepoSnapshot, path: string): ReadableFile | undefined {
  return snapshot.files.get(path);
}

function pathValue(root: unknown, path: string): { present: boolean; value: unknown } {
  let current = root;

  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) {
      return { present: false, value: undefined };
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return { present: true, value: current };
}

function parseObjectFile(snapshot: RepoSnapshot, path: string): ParseResult {
  const value = fileValue(snapshot, path);

  if (value === undefined) {
    return snapshot.tree?.truncated || snapshot.tree === null
      ? {
          ok: false,
          detail: `File ${path} could not be read from the repository tree.`,
          missing: false,
        }
      : { ok: false, detail: `File ${path} was not found.`, missing: true };
  }

  if (typeof value !== "string") {
    return { ok: false, detail: value.error, missing: false };
  }

  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch (error) {
    return {
      ok: false,
      detail: `Could not parse ${path}: ${error instanceof Error ? error.message : "invalid JSON"}`,
      missing: false,
    };
  }
}

function parseYamlFile(snapshot: RepoSnapshot, path: string): ParseResult {
  const value = fileValue(snapshot, path);

  if (value === undefined) {
    return snapshot.tree?.truncated || snapshot.tree === null
      ? {
          ok: false,
          detail: `File ${path} could not be read from the repository tree.`,
          missing: false,
        }
      : { ok: false, detail: `File ${path} was not found.`, missing: true };
  }

  if (typeof value !== "string") {
    return { ok: false, detail: value.error, missing: false };
  }

  try {
    return { ok: true, value: parseYaml(value) };
  } catch (error) {
    return {
      ok: false,
      detail: `Could not parse ${path}: ${error instanceof Error ? error.message : "invalid YAML"}`,
      missing: false,
    };
  }
}

function normalized(value: string): string {
  return `${value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n*$/u, "")}\n`;
}

function exactDependency(version: string): boolean {
  return !/^(?:[~^]|catalog:|workspace:)/u.test(version);
}

function settingValue(
  settings: Record<string, unknown>,
  key: string,
): { present: boolean; value: unknown } {
  return pathValue(settings, key);
}

function protectionFlag(state: ProtectionState, key: string): unknown {
  if (key === "dismissStaleReviews") {
    return state.reviews?.dismissStaleReviews ?? false;
  }

  if (key === "requireCodeOwnerReviews") {
    return state.reviews?.requireCodeOwnerReviews ?? false;
  }

  if (key === "requireLastPushApproval") {
    return state.reviews?.requireLastPushApproval ?? false;
  }

  if (key === "requiredApprovingReviews") {
    return state.reviews?.requiredApprovingReviews ?? 0;
  }

  if (key === "requiredStatusChecks") {
    return state.statusChecks?.checks.map((check) => check.context) ?? [];
  }

  return protectionValueByName(state, key);
}

function protectionValueByName(state: ProtectionState, key: string): unknown {
  switch (key) {
    case "requiredSignatures":
      return state.requiredSignatures;
    case "enforceAdmins":
      return state.enforceAdmins;
    case "requiredLinearHistory":
      return state.requiredLinearHistory;
    case "allowForcePushes":
      return state.allowForcePushes;
    case "allowDeletions":
      return state.allowDeletions;
    case "requiredConversationResolution":
      return state.requiredConversationResolution;
    default:
      return key === "restricted" ? state.restricted : undefined;
  }
}

function protectionState(fact: BranchProtectionFact): ProtectionState | null {
  if (fact.status === "unknown") {
    return null;
  }

  if (fact.status === "unprotected") {
    return {
      requiredSignatures: false,
      enforceAdmins: false,
      requiredLinearHistory: false,
      allowForcePushes: true,
      allowDeletions: true,
      requiredConversationResolution: false,
      reviews: null,
      statusChecks: null,
      restricted: false,
    };
  }

  return fact.protection;
}

function runBranchProtection(
  check: Extract<Check, { type: "branch-protection" }>,
  snapshot: RepoSnapshot,
): CheckResult {
  const branch = check.branch ?? snapshot.repo.defaultBranch;
  const fact = snapshot.protection.get(branch);

  if (!fact) {
    return result(check, "unknown", {
      path: branch,
      expected: check.equals,
      detail: "Branch protection was not collected.",
    });
  }

  if (fact.status === "unknown") {
    return result(check, "unknown", { path: branch, expected: check.equals, detail: fact.reason });
  }

  const state = protectionState(fact);
  const key = check.key === "required_linear_history" ? "requiredLinearHistory" : check.key;
  const actual = state ? protectionFlag(state, key) : undefined;

  if (actual === null || actual === undefined) {
    return result(check, "unknown", {
      path: branch,
      expected: check.equals,
      detail: "GitHub did not report this protection setting.",
    });
  }

  return result(check, actual === check.equals ? "pass" : "fail", {
    path: branch,
    expected: check.equals,
    actual,
  });
}

export function runCheck(
  check: Check,
  snapshot: RepoSnapshot,
  practiceFiles: Record<string, string>,
): CheckResult {
  if (check.type === "file-exists") {
    const present = snapshot.tree?.paths.has(check.path);

    if (present === true) {
      return result(check, check.absent ? "fail" : "pass", {
        path: check.path,
        expected: !check.absent,
        actual: true,
      });
    }

    if (present === false && snapshot.tree?.truncated) {
      return result(check, "unknown", {
        path: check.path,
        expected: !check.absent,
        detail: "The repository tree was truncated.",
      });
    }

    if (present === null || snapshot.tree === null) {
      return result(check, "unknown", {
        path: check.path,
        expected: !check.absent,
        detail: snapshot.treeError ?? "The repository tree could not be read.",
      });
    }

    return result(check, check.absent ? "pass" : "fail", {
      path: check.path,
      expected: !check.absent,
      actual: false,
    });
  }

  if (check.type === "file-matches" || check.type === "file-contains") {
    if (check.type === "file-matches" && practiceFiles[check.source] === undefined) {
      return result(check, "unknown", {
        path: check.path,
        detail: `Practice source ${check.source} was not loaded.`,
      });
    }

    const value = fileValue(snapshot, check.path);

    if (value === undefined) {
      const unknown = snapshot.tree === null || snapshot.tree?.truncated;
      return result(check, unknown ? "unknown" : "fail", {
        path: check.path,
        expected: check.type === "file-matches" ? practiceFiles[check.source] : check.text,
        detail: unknown ? "The repository tree was incomplete or unavailable." : null,
      });
    }

    if (typeof value !== "string") {
      return result(check, "unknown", { path: check.path, detail: value.error });
    }

    if (check.type === "file-matches") {
      const expected = practiceFiles[check.source];

      return result(check, normalized(value) === normalized(expected) ? "pass" : "fail", {
        path: check.path,
        expected: normalized(expected),
        actual: normalized(value),
      });
    }

    return result(check, value.includes(check.text) ? "pass" : "fail", {
      path: check.path,
      expected: check.text,
      actual: value,
    });
  }

  if (check.type === "json-path" || check.type === "yaml-path") {
    const parsed =
      check.type === "json-path"
        ? parseObjectFile(snapshot, check.file)
        : parseYamlFile(snapshot, check.file);

    if (!parsed.ok) {
      return result(check, parsed.missing ? "fail" : "unknown", {
        path: check.file,
        detail: parsed.missing ? null : parsed.detail,
      });
    }

    const located = pathValue(parsed.value, check.path);
    const expected = "equals" in check ? check.equals : check.exists;
    const passes =
      "equals" in check
        ? located.present && located.value === check.equals
        : located.present === check.exists;

    return result(check, passes ? "pass" : "fail", {
      path: check.file,
      expected,
      actual: located.present ? located.value : undefined,
    });
  }

  if (check.type === "dependency") {
    const parsed = parseObjectFile(snapshot, check.file);

    if (!parsed.ok) {
      return result(check, parsed.missing ? "fail" : "unknown", {
        path: check.file,
        detail: parsed.missing ? null : parsed.detail,
      });
    }

    const manifest = z.record(z.string(), z.unknown()).safeParse(parsed.value).data;
    const sections = [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ];
    const declarations = sections.flatMap((section) => {
      const values = z.record(z.string(), z.unknown()).safeParse(manifest?.[section]).data;
      const value = values?.[check.name];
      return typeof value === "string" ? [value] : [];
    });

    if (!declarations.length) {
      return result(check, "fail", { path: check.file, expected: check.version });
    }

    const actual = declarations.find((version) => version === check.version) ?? declarations[0];

    if (!exactDependency(actual)) {
      return result(check, "unknown", {
        path: check.file,
        expected: check.version,
        actual,
        detail: "Dependency version is not an exact version.",
      });
    }

    return result(check, actual === check.version ? "pass" : "fail", {
      path: check.file,
      expected: check.version,
      actual,
    });
  }

  if (check.type === "setting") {
    const settingsError = snapshot.settings
      ? z.object({ error: z.string() }).safeParse(snapshot.settings).data?.error
      : undefined;

    if (!snapshot.settings || settingsError !== undefined) {
      return result(check, "unknown", {
        path: null,
        expected: check.equals,
        detail: settingsError ?? "Repository settings were not collected.",
      });
    }

    const located = settingValue(snapshot.settings, check.key);

    if (!located.present) {
      return result(check, "unknown", {
        expected: check.equals,
        detail: "GitHub did not disclose this setting.",
      });
    }

    return result(check, located.value === check.equals ? "pass" : "fail", {
      expected: check.equals,
      actual: located.value,
    });
  }

  if (check.type === "branch-protection") {
    return runBranchProtection(check, snapshot);
  }

  const workflowPaths = snapshot.tree?.paths
    ? [...snapshot.tree.paths]
        .filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path))
        .toSorted()
    : [];

  if (!snapshot.tree) {
    return result(check, "unknown", {
      detail: snapshot.treeError ?? "The repository tree could not be read.",
    });
  }

  if (snapshot.tree.truncated) {
    return result(check, "unknown", { detail: "The repository tree was truncated." });
  }

  if (!workflowPaths.length) {
    return result(check, check.check === "dependency-review" ? "fail" : "pass", {
      detail: "No workflow files found.",
    });
  }

  const states = workflowPaths.map((path) => {
    const value = snapshot.files.get(path);

    if (typeof value !== "string") {
      return {
        path,
        state: "unknown" as const,
        detail:
          typeof value === "object" && value ? value.error : "Workflow file could not be read.",
      };
    }

    const state = inspectWorkflow(value, check.check);
    return { path, state, detail: state === "unknown" ? "Workflow could not be parsed." : null };
  });
  const failed = states.find((item) => item.state === false);
  const unknown = states.find((item) => item.state === "unknown");

  if (failed) {
    return result(check, "fail", {
      path: failed.path,
      detail: "A workflow failed the selected inspection.",
    });
  }

  if (unknown) {
    return result(check, "unknown", { path: unknown.path, detail: unknown.detail });
  }

  return result(check, "pass", { path: workflowPaths[0] });
}

export function aggregate(results: CheckResult[]): {
  state: Exclude<PracticeState, "not_applicable">;
  failing: number;
  unknown: number;
} {
  const failing = results.filter((item) => item.state === "fail").length;
  const unknown = results.filter((item) => item.state === "unknown").length;

  return {
    state: failing > 0 ? "fail" : unknown > 0 ? "unknown" : "pass",
    failing,
    unknown,
  };
}
