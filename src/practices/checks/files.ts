import { readTextFile } from "../repository-files";
import type { Check } from "../schema";
import type { RepoSnapshot } from "../snapshot";
import type { CheckOutcome } from "./result";

type FileExistsCheck = Extract<Check, { type: "file-exists" }>;

type FileMatchesCheck = Extract<Check, { type: "file-matches" }>;

type FileContainsCheck = Extract<Check, { type: "file-contains" }>;

export type PracticeFiles = Readonly<Record<string, string | undefined>>;

function normalized(value: string): string {
  return `${value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n*$/u, "")}\n`;
}

export function inspectFileExists(check: FileExistsCheck, snapshot: RepoSnapshot): CheckOutcome {
  const evidence = { path: check.path, expected: !check.absent };

  if (!snapshot.tree) {
    return {
      ...evidence,
      state: "unknown",
      detail: snapshot.treeError ?? "The repository tree could not be read.",
    };
  }

  const present = snapshot.tree.paths.has(check.path);

  if (!present && snapshot.tree.truncated) {
    return { ...evidence, state: "unknown", detail: "The repository tree was truncated." };
  }

  return { ...evidence, state: present === !check.absent ? "pass" : "fail", actual: present };
}

export function inspectFileMatches(
  check: FileMatchesCheck,
  snapshot: RepoSnapshot,
  practiceFiles: PracticeFiles,
): CheckOutcome {
  const source = practiceFiles[check.source];

  if (source === undefined) {
    return {
      state: "unknown",
      path: check.path,
      detail: `Practice source ${check.source} was not loaded.`,
    };
  }

  const file = readTextFile(snapshot, check.path);

  switch (file.status) {
    case "missing":
      return { state: "fail", path: check.path, expected: source };
    case "unavailable":
      return { state: "unknown", path: check.path, detail: file.detail };
    case "available": {
      const expected = normalized(source);
      const actual = normalized(file.value);

      return { state: actual === expected ? "pass" : "fail", path: check.path, expected, actual };
    }
  }
}

export function inspectFileContains(
  check: FileContainsCheck,
  snapshot: RepoSnapshot,
): CheckOutcome {
  const file = readTextFile(snapshot, check.path);

  switch (file.status) {
    case "missing":
      return { state: "fail", path: check.path, expected: check.text };
    case "unavailable":
      return { state: "unknown", path: check.path, detail: file.detail };
    case "available":
      return {
        state: file.value.includes(check.text) ? "pass" : "fail",
        path: check.path,
        expected: check.text,
        actual: file.value,
      };
  }
}
