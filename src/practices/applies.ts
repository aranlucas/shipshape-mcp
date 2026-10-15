import type { RepoSnapshot } from "./snapshot";
import type { Practice } from "./schema";
import type { StoredRepository } from "./store";
import { globMatches } from "../drift/policy";

type SnapshotTree = Pick<RepoSnapshot, "tree">;

export function applies(
  practice: Practice,
  repo: StoredRepository,
  snapshot: SnapshotTree,
): boolean | "unknown" {
  const selection = practice.appliesTo;

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
