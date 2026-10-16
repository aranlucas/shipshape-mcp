import type { CheckResult, RepoSummary } from "../api/contract";

const FILE_CHECKS = new Set([
  "ci-required-checks",
  "ci-test-script",
  "required-package-scripts",
  "file-exists",
  "file-matches",
  "file-contains",
  "json-path",
  "yaml-path",
  "dependency",
  "workflow",
  "oxforge",
  "oxforge-format",
  "dependabot-grouped",
  "husky-lint-staged",
  "preferred-package-manager",
  "pnpm-setup",
]);

/** Evidence must point at the evaluated commit, never the moving default branch. */
export function evidenceLink(
  repo: RepoSummary,
  sha: string | null,
  check: CheckResult,
): string | null {
  if (!sha || !/^[a-f0-9]{40}$/u.test(sha) || !FILE_CHECKS.has(check.type) || !check.path) {
    return null;
  }

  const segments = check.path.split("/");

  if (segments.some((part) => !part || part === "." || part === "..")) {
    return null;
  }

  const base = `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  // A missing file cannot be opened. Show the inspected tree instead.
  const missing = check.type === "file-exists" && check.actual === "false";

  return missing
    ? `${base}/tree/${sha}`
    : `${base}/blob/${sha}/${segments.map(encodeURIComponent).join("/")}`;
}
