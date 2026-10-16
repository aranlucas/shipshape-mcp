import type { RepoSnapshot } from "./snapshot";
import type { Practice } from "./schema";
import type { StoredRepository } from "./store";

/** Wildcard matching with `*` and `?`, linear in pattern times name length. */
export function globMatches(pattern: string, name: string): boolean {
  const glob = pattern.toLowerCase();
  const value = name.toLowerCase();
  let patternIndex = 0;
  let valueIndex = 0;
  let star = -1;
  let resume = 0;

  while (valueIndex < value.length) {
    if (
      patternIndex < glob.length &&
      (glob[patternIndex] === "?" || glob[patternIndex] === value[valueIndex])
    ) {
      patternIndex += 1;
      valueIndex += 1;
    } else if (patternIndex < glob.length && glob[patternIndex] === "*") {
      star = patternIndex;
      resume = valueIndex;
      patternIndex += 1;
    } else if (star !== -1) {
      patternIndex = star + 1;
      resume += 1;
      valueIndex = resume;
    } else {
      return false;
    }
  }

  while (glob[patternIndex] === "*") {
    patternIndex += 1;
  }

  return patternIndex === glob.length;
}

type SnapshotTree = Pick<RepoSnapshot, "tree">;

export function applies(
  practice: Practice,
  repo: StoredRepository,
  snapshot: SnapshotTree,
): boolean | "unknown" {
  const selection = practice.appliesTo;

  if (selection.visibility && repo.private !== (selection.visibility === "private")) {
    return false;
  }

  if (
    selection.owners &&
    !selection.owners.some((owner) => owner.toLowerCase() === repo.owner.toLowerCase())
  ) {
    return false;
  }

  if (selection.languages && (!repo.language || !selection.languages.includes(repo.language))) {
    return false;
  }

  if (repo.archived && !selection.archived) {
    return false;
  }

  if (repo.fork && !selection.forks) {
    return false;
  }

  if (!selection.include.some((pattern) => globMatches(pattern, repo.name))) {
    return false;
  }

  if (selection.exclude.some((pattern) => globMatches(pattern, repo.name))) {
    return false;
  }

  if (!selection.hasFiles?.length) {
    return true;
  }

  if (!snapshot.tree) {
    return "unknown";
  }

  const missing = selection.hasFiles.some((path) => !snapshot.tree?.paths.has(path));

  return missing && snapshot.tree.truncated ? "unknown" : !missing;
}
