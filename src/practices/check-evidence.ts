import type { Check } from "./schema";

export const CHECK_EVIDENCE = {
  "portless-dev": "file",
  "cloudflare-cf-cli": "file",
  "ci-required-checks": "file",
  "ci-test-script": "file",
  "pr-workflow-efficiency": "file",
  "required-package-scripts": "file",
  "vitest-test-script": "file",
  "file-exists": "file",
  "file-matches": "file",
  "file-contains": "file",
  "json-path": "file",
  "yaml-path": "file",
  dependency: "file",
  workflow: "file",
  oxforge: "file",
  "oxforge-format": "file",
  "dependabot-grouped": "file",
  "husky-lint-staged": "file",
  "preferred-package-manager": "file",
  "pnpm-setup": "file",
  setting: "settings",
  "branch-protection": "protection",
} satisfies Record<Check["type"], "file" | "settings" | "protection">;

export function hasFileEvidence(type: string): boolean {
  return Object.entries(CHECK_EVIDENCE).some(
    ([name, evidence]) => name === type && evidence === "file",
  );
}

export function hasMutableInputs(check: Check): boolean {
  return CHECK_EVIDENCE[check.type] !== "file" || check.type === "ci-required-checks";
}
