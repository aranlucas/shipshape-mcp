import type { CheckResult } from "../api/contract";
import { inspectCiRequiredChecks } from "./ci-required-checks";
import { inspectCiTestScript } from "./ci-test-script";
import {
  inspectFileExists,
  inspectFileMatches,
  inspectFileContains,
  type PracticeFiles,
} from "./checks/files";
import { formatCheckResult, type CheckOutcome } from "./checks/result";
import { inspectSetting, inspectBranchProtection } from "./checks/settings";
import { inspectPath, inspectDependency } from "./checks/structured";
import { inspectWorkflows } from "./checks/workflow";
import { inspectLintStaged } from "./lint-staged";
import { inspectVitestTestScripts } from "./vitest-test-script";
import type { Check } from "./schema";
import { inspectOxforge, inspectOxforgeFormat, inspectDependabot } from "./semantic-checks";
import type { RepoSnapshot } from "./snapshot";
import { inspectPackageManager, inspectPnpmSetup } from "./package-manager";

function inspectCheck(
  check: Check,
  snapshot: RepoSnapshot,
  practiceFiles: PracticeFiles,
): CheckOutcome {
  switch (check.type) {
    case "ci-required-checks":
      return inspectCiRequiredChecks(snapshot);
    case "ci-test-script":
      return inspectCiTestScript(snapshot);
    case "preferred-package-manager":
      return inspectPackageManager(snapshot);
    case "pnpm-setup":
      return inspectPnpmSetup(snapshot);
    case "vitest-test-script":
      return inspectVitestTestScripts(snapshot);
    case "oxforge-format":
      return inspectOxforgeFormat(check, snapshot);
    case "husky-lint-staged":
      return inspectLintStaged(snapshot);
    case "oxforge":
      return inspectOxforge(check, snapshot);
    case "dependabot-grouped":
      return inspectDependabot(check, snapshot);
    case "file-exists":
      return inspectFileExists(check, snapshot);
    case "file-matches":
      return inspectFileMatches(check, snapshot, practiceFiles);
    case "file-contains":
      return inspectFileContains(check, snapshot);
    case "json-path":
    case "yaml-path":
      return inspectPath(check, snapshot);
    case "dependency":
      return inspectDependency(check, snapshot);
    case "setting":
      return inspectSetting(check, snapshot);
    case "branch-protection":
      return inspectBranchProtection(check, snapshot);
    case "workflow":
      return inspectWorkflows(check, snapshot);
    default:
      check satisfies never;
      throw new Error("Unsupported practice check.");
  }
}

export function runCheck(
  check: Check,
  snapshot: RepoSnapshot,
  practiceFiles: PracticeFiles,
): CheckResult {
  return formatCheckResult(check, inspectCheck(check, snapshot, practiceFiles));
}

interface CheckSummary {
  state: CheckResult["state"];
  failing: number;
  unknown: number;
}

export function aggregate(results: CheckResult[]): CheckSummary {
  const failing = results.filter((item) => item.state === "fail").length;
  const unknown = results.filter((item) => item.state === "unknown").length;

  return { state: failing > 0 ? "fail" : unknown > 0 ? "unknown" : "pass", failing, unknown };
}
