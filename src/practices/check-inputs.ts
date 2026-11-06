import { CHECK_EVIDENCE, hasFileEvidence } from "./check-evidence";
import type { Check, Practice } from "./schema";
import { LINT_CONFIG_NAMES, joinPath } from "./lint-config";
import { LINT_STAGED_CONFIG_NAMES } from "./lint-staged";
import { CI_WORKFLOW_PATH } from "./ci-required-checks";

export const WORKFLOW_MARKER = ".github/workflows/*";
export const PACKAGE_MARKER = "**/package.json";

export function snapshotInputs(practices: Practice[], defaultBranch: string) {
  const checks = practices.flatMap((practice) => practice.checks);

  return {
    files: filesNeeded(practices),
    tree:
      practices.some((practice) => Boolean(practice.appliesTo.hasFiles?.length)) ||
      checks.some((check) => hasFileEvidence(check.type)),
    settings: checks.some((check) => CHECK_EVIDENCE[check.type] === "settings"),
    branches: new Set(
      checks.flatMap((check) =>
        check.type === "ci-required-checks"
          ? [defaultBranch]
          : check.type === "branch-protection"
            ? [check.branch ?? defaultBranch]
            : [],
      ),
    ),
  };
}

function checkFilePath(check: Check): string | null {
  switch (check.type) {
    case "portless-dev":
      return joinPath(check.directory, "package.json");
    case "ci-required-checks":
    case "ci-test-script":
      return CI_WORKFLOW_PATH;
    case "dependabot-grouped":
      return check.path;
    case "file-matches":
    case "file-contains":
      return check.path;
    case "json-path":
    case "yaml-path":
    case "dependency":
      return check.file;
    case "branch-protection":
    case "cloudflare-cf-cli":
    case "file-exists":
    case "husky-lint-staged":
    case "oxforge":
    case "oxforge-format":
    case "pnpm-setup":
    case "pr-workflow-efficiency":
    case "preferred-package-manager":
    case "required-package-scripts":
    case "setting":
    case "vitest-test-script":
    case "workflow":
      return null;
  }
}

export function filesNeeded(practices: Practice[]): string[] {
  const paths = new Set<string>();

  for (const practice of practices) {
    for (const check of practice.checks) {
      if (check.type === "ci-test-script") {
        paths.add("package.json");
      }

      if (
        check.type === "vitest-test-script" ||
        check.type === "required-package-scripts" ||
        check.type === "preferred-package-manager" ||
        check.type === "cloudflare-cf-cli"
      ) {
        paths.add(PACKAGE_MARKER);
      }

      if (
        check.type === "preferred-package-manager" ||
        check.type === "pnpm-setup" ||
        check.type === "cloudflare-cf-cli"
      ) {
        paths.add(WORKFLOW_MARKER);
        paths.add("**/action.yml");
      }

      if (check.type === "oxforge-format") {
        paths.add(joinPath(check.directory, "package.json"));
        paths.add(joinPath(check.directory, "oxfmt.config.ts"));
      }

      if (check.type === "husky-lint-staged") {
        paths.add("package.json");
        paths.add(".husky/pre-commit");

        for (const name of LINT_STAGED_CONFIG_NAMES) {
          paths.add(name);
        }
      }

      if (check.type === "oxforge") {
        paths.add(joinPath(check.directory, "package.json"));

        for (const name of LINT_CONFIG_NAMES) {
          paths.add(joinPath(check.directory, name));
        }
      }

      const path = checkFilePath(check);

      if (path) {
        paths.add(path);
      }

      if (check.type === "workflow" || check.type === "pr-workflow-efficiency") {
        paths.add(WORKFLOW_MARKER);
      }
    }
  }

  return [...paths];
}
