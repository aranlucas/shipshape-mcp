import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { makeCheck } from "../domain/rules";
import {
  normalizeChecks,
  scoreChecks,
  buildActionPlan,
} from "../domain/scoring";
import type { CheckResult, CheckState } from "../domain/types";
import {
  parseYaml,
  type RULE_NAMES,
  type Commands,
  type Policy,
} from "./policy";

export interface StandardsSource {
  repository: string;
  commit: string;
  /** All discovered paths. Null contents mean unreadable or outside the read budget. */
  files: Record<string, string | null>;
  complete: boolean;
  policy: Policy;
  policyState: "pass" | "fail" | "unknown";
  policyEvidence?: string;
  collectedAt: string;
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const join = (path: string, name: string) =>
  path === "." ? name : `${path}/${name}`;
function json(text: string | null | undefined): Record<string, unknown> | null {
  if (text == null) return null;
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  return errors.length ? null : object(value);
}
export function evaluateStandards(source: StandardsSource) {
  const { files, policy } = source;
  const paths = Object.keys(files).sort();
  const directories = [
    ...new Set(
      paths
        .filter((path) =>
          /(^|\/)(package.json|go.mod|pyproject.toml)$/.test(path),
        )
        .map((path) =>
          path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".",
        ),
    ),
  ];
  for (const pkg of policy.packages)
    if (!directories.includes(pkg.path)) directories.push(pkg.path);
  if (!directories.length) directories.push(".");
  const workflowPaths = paths.filter((path) =>
    /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path),
  );
  const workflows = workflowPaths.map((path) => {
    try {
      return {
        path,
        value: files[path] == null ? null : object(parseYaml(files[path])),
      };
    } catch {
      return { path, value: null };
    }
  });
  const prWorkflows = workflows.filter(({ value }) => {
    const on = value?.on;
    return (
      on === "pull_request" ||
      (Array.isArray(on) && on.includes("pull_request")) ||
      Object.hasOwn(object(on), "pull_request")
    );
  });
  const uncertainWorkflows =
    !source.complete || workflows.some(({ value }) => value === null);
  const packages = directories
    .sort()
    .slice(0, 20)
    .map((path) => {
      const manifestPath = join(path, "package.json");
      const manifest = json(files[manifestPath]);
      const scripts = object(manifest?.scripts);
      const node = Object.hasOwn(files, manifestPath);
      const go = Object.hasOwn(files, join(path, "go.mod"));
      const python = Object.hasOwn(files, join(path, "pyproject.toml"));
      const commands: Commands = {};
      for (const gate of ["format", "lint", "test", "typecheck"] as const) {
        const key =
          gate === "format" && typeof scripts["format:check"] === "string"
            ? "format:check"
            : gate;
        if (typeof scripts[key] === "string" && scripts[key].trim())
          commands[gate] = `npm run ${key}`;
      }
      Object.assign(
        commands,
        policy.packages.find((pkg) => pkg.path === path)?.commands,
      );
      const checks: CheckResult[] = [];
      const exceptions: Policy["exceptions"] = [];
      function add(
        rule: (typeof RULE_NAMES)[number],
        state: CheckState,
        evidencePaths: string[],
        detail: string,
      ) {
        if (source.policyState === "unknown") state = "unknown";
        const exception =
          source.policyState === "unknown"
            ? undefined
            : policy.exceptions.find(
                (item) =>
                  item.rule === rule &&
                  item.path === path &&
                  item.expires >= source.collectedAt.slice(0, 10),
              );
        if (exception && rule !== "baseline") {
          exceptions.push(exception);
          state = "not_applicable";
          detail = `Exception until ${exception.expires}: ${exception.reason}`;
        }
        checks.push(
          makeCheck({
            ruleId: `standards.${rule}`,
            state,
            evidence: evidencePaths.map((file) => ({
              url: `https://github.com/${source.repository}/blob/${source.commit}/${file.split("/").map(encodeURIComponent).join("/")}`,
              label: `${path}: ${rule}`,
              detail,
            })),
            remediation: `${path}: ${detail}`,
          }),
        );
      }
      add(
        "baseline",
        source.policyState,
        [".shipshape.yml"],
        source.policyState === "pass"
          ? "Shared baseline version is pinned."
          : "Add or verify .shipshape.yml with baseline: shipshape/recommended@1.",
      );
      for (const gate of ["format", "lint", "test", "typecheck"] as const) {
        const applicable = gate !== "typecheck" || !go;
        add(
          gate,
          !applicable
            ? "not_applicable"
            : commands[gate]
              ? "pass"
              : node && manifest
                ? "fail"
                : "unknown",
          [node ? manifestPath : ".shipshape.yml"],
          commands[gate]
            ? `Declared command: ${commands[gate]}. Execution is not verified.`
            : `Declare a ${gate} check in package scripts or .shipshape.yml packages[].commands.`,
        );
      }
      const ancestors = [path];
      while (ancestors[ancestors.length - 1] !== ".") {
        const last = ancestors[ancestors.length - 1]!;
        ancestors.push(
          last.includes("/") ? last.slice(0, last.lastIndexOf("/")) : ".",
        );
      }
      // Ancestor lockfiles are evidence of a possible workspace, not proof of membership.
      const locks = node
        ? [
            "pnpm-lock.yaml",
            "package-lock.json",
            "yarn.lock",
            "bun.lock",
            "bun.lockb",
          ]
        : go
          ? ["go.sum"]
          : python
            ? ["uv.lock", "poetry.lock", "pdm.lock"]
            : [];
      const localLocks = locks
        .map((name) => join(path, name))
        .filter((name) => Object.hasOwn(files, name));
      const ancestorLocks = ancestors
        .slice(1)
        .flatMap((dir) => locks.map((name) => join(dir, name)))
        .filter((name) => Object.hasOwn(files, name));
      add(
        "lockfile",
        localLocks.length
          ? "pass"
          : !locks.length
            ? "not_applicable"
            : ancestorLocks.length || !source.complete || go
              ? "unknown"
              : "fail",
        [
          ...localLocks,
          ...ancestorLocks,
          node ? manifestPath : join(path, go ? "go.mod" : "pyproject.toml"),
        ],
        ancestorLocks.length && !localLocks.length
          ? "Verify that the ancestor lockfile includes this workspace package."
          : "Commit the ecosystem lockfile; Go modules without external dependencies may not need go.sum.",
      );
      const tsPath = join(path, "tsconfig.json");
      const ts = json(files[tsPath]);
      const strict = object(ts?.compilerOptions).strict;
      const hasTs =
        Object.hasOwn(files, tsPath) ||
        paths.some(
          (name) =>
            name.startsWith(path === "." ? "" : `${path}/`) &&
            /\.tsx?$/.test(name),
        );
      add(
        "strict",
        !hasTs
          ? source.complete
            ? "not_applicable"
            : "unknown"
          : strict === true
            ? "pass"
            : strict === false
              ? "fail"
              : !ts ||
                  ts.extends ||
                  (Array.isArray(ts.references) && ts.references.length > 0)
                ? "unknown"
                : "fail",
        [tsPath],
        "Enable compilerOptions.strict. Inherited or unavailable compiler settings require verification.",
      );
      add(
        "ci-pr",
        prWorkflows.length ? "pass" : uncertainWorkflows ? "unknown" : "fail",
        workflowPaths.length ? workflowPaths : [".github/workflows"],
        "Configure a pull_request workflow; event filters and actual execution are not verified.",
      );
      const invoked = new Set<string>();
      for (const workflow of prWorkflows) {
        for (const job of Object.values(object(workflow.value?.jobs))) {
          const j = object(job);
          if (j.if !== undefined || j["continue-on-error"] || j.uses) continue;
          const steps = Array.isArray(j.steps) ? j.steps : [];
          for (const step of steps) {
            const s = object(step);
            if (
              s.if !== undefined ||
              s["continue-on-error"] ||
              typeof s.run !== "string"
            )
              continue;
            const working =
              s["working-directory"] ??
              object(object(j.defaults).run)["working-directory"] ??
              object(object(workflow.value?.defaults).run)[
                "working-directory"
              ] ??
              ".";
            if (working !== path) continue;
            // Only standalone or &&-joined commands are recognized. Shell wrappers stay unknown.
            if (
              /(?:^|\n)\s*(?:if|for|while|case|until|exit|cd|set)\b|[|;`$]/.test(
                s.run,
              )
            )
              continue;
            const lines = s.run.split(/\n|&&/).map((line) => line.trim());
            const expanded = new Set(lines);
            const visit = (line: string, seen = new Set<string>()) => {
              const match =
                /^(npm run|pnpm(?: run)?|yarn(?: run)?) ([\w:-]+)$/.exec(line);
              if (!match || seen.has(match[2]!) || seen.size >= 32) return;
              const key = match[2]!;
              seen.add(key);
              expanded.add(`npm run ${key}`);
              const script = scripts[key];
              if (typeof script === "string")
                for (const sub of script
                  .split("&&")
                  .map((part) => part.trim())) {
                  expanded.add(sub);
                  visit(sub, seen);
                }
            };
            for (const line of lines) visit(line);
            for (const [gate, command] of Object.entries(commands))
              if (expanded.has(command)) invoked.add(gate);
          }
        }
      }
      const required = [
        "format",
        "lint",
        "test",
        ...(!go ? ["typecheck"] : []),
      ];
      const missing = required.filter((gate) => !invoked.has(gate));
      add(
        "ci-gates",
        !missing.length
          ? "pass"
          : !prWorkflows.length && !uncertainWorkflows
            ? "fail"
            : "unknown",
        prWorkflows.map((workflow) => workflow.path),
        missing.length
          ? `Verify CI invokes these quality commands for ${path}: ${missing.join(", ")}. Indirect, conditional, or external workflows are not resolved.`
          : "Quality commands are wired in PR workflow steps. Runtime success is not verified.",
      );
      const updateFiles = paths.filter((name) =>
        /^(\.github\/dependabot\.ya?ml|renovate\.json5?|\.renovaterc(?:\.json)?|\.github\/renovate\.json5?)$/.test(
          name,
        ),
      );
      add(
        "updates",
        updateFiles.length ? "pass" : source.complete ? "fail" : "unknown",
        updateFiles.length ? updateFiles : [".github"],
        "Dependency update configuration presence only; ecosystem coverage and scheduler execution require verification.",
      );
      return {
        path,
        profiles: [
          node ? "node" : null,
          go ? "go" : null,
          python ? "python" : null,
        ].filter(Boolean),
        commands,
        exceptions,
        audit: scoreChecks(checks),
      };
    });
  const checks = normalizeChecks(packages.flatMap((pkg) => pkg.audit.checks));
  const complete =
    source.complete &&
    directories.length <= 20 &&
    workflows.every(({ value }) => value !== null) &&
    paths
      .filter((name) =>
        /(^|\/)(package.json|tsconfig.json|go.mod|pyproject.toml)$/.test(name),
      )
      .every((name) => files[name] !== null);
  return {
    repository: source.repository,
    commit: source.commit,
    baseline: policy.baseline,
    policyEvidence: source.policyEvidence,
    collectedAt: source.collectedAt,
    complete,
    status: checks.some((check) => check.state === "fail")
      ? "needs-attention"
      : !complete || checks.some((check) => check.state === "unknown")
        ? "unknown"
        : "meets-baseline",
    limitations: [
      "Static configuration audit; commands are never executed.",
      "Repository rollup uses the worst state per rule; package audits retain individual findings.",
      "Inherited TypeScript settings, workspace membership, CI conditions, and dependency updater coverage may need verification.",
    ],
    expiredExceptions: policy.exceptions.filter(
      (item) => item.expires < source.collectedAt.slice(0, 10),
    ),
    packages,
    audit: scoreChecks(checks),
    plan: buildActionPlan(checks),
  };
}
