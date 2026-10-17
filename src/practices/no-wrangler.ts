import { z } from "zod";
import { ConfigObjectSchema, type ConfigDocument, type ConfigValue } from "./config-value";
import type { CheckOutcome } from "./checks/result";
import { readConfigFile } from "./repository-files";
import { hidesCommandSubstitution, invokesShellCommand } from "./shell-command";
import type { RepoSnapshot } from "./snapshot";

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const Scripts = z.record(z.string(), z.string());

// A bounded command recognizer: quoted prose is not an executable invocation.
const WRANGLER_COMMAND =
  /^\s*(?:(?:env|command|exec|if|then|do|sudo|cross-env|corepack)\s+|[A-Za-z_]\w*=\S+\s+)*(?:(?:(?:pnpm|yarn)\s+(?:exec|dlx)\s+|bun\s+x\s+|bunx\s+|npx\s+(?:(?:--yes|-y|--no-install)\s+)?|npm\s+exec\s+(?:--\s+)?))?(?:(?:\.\/)?node_modules\/\.bin\/)?(?:wrangler(?:@[^\s'"]+)?|"wrangler"|'wrangler')(?=\s|$)/u;

const WRANGLER_ALIAS = /^\s*(?:pnpm|yarn|bun|bunx|npx|npm)\s+.*\bwrangler(?:@[^\s]+)?(?=\s|$)/u;

const INDIRECT_SHELL = /^\s*(?:(?:exec|env)\s+)*(?:(?:sh|bash|zsh)\s+-[\w]*c|eval\s|\$)/u;

function inspectCommand(source: string): CheckOutcome {
  if (invokesShellCommand(source, WRANGLER_COMMAND)) {
    return {
      state: "fail",
      detail: "Replace this explicit Wrangler CLI invocation with the supported cf command.",
    };
  }

  if (
    invokesShellCommand(source, WRANGLER_ALIAS) ||
    invokesShellCommand(source, INDIRECT_SHELL) ||
    hidesCommandSubstitution(source)
  ) {
    return {
      state: "unknown",
      detail: "Review the package alias or indirect shell command for Wrangler usage.",
    };
  }

  return { state: "pass" };
}

function summarize(outcomes: CheckOutcome[]): CheckOutcome {
  return (
    outcomes.find((outcome) => outcome.state === "fail") ??
    outcomes.find((outcome) => outcome.state === "unknown") ?? { state: "pass" }
  );
}

function inspectManifest(manifest: ConfigDocument): CheckOutcome {
  // Check names before validating versions so a known banned declaration still fails.
  const declarations = DEPENDENCY_SECTIONS.map((section) =>
    ConfigObjectSchema.safeParse(manifest[section]),
  );

  const banned = declarations.find(
    (section) =>
      section.success &&
      Object.entries(section.data).some(
        ([name, version]) =>
          name === "wrangler" ||
          /^npm:wrangler(?:@|$)/u.test(z.string().safeParse(version).data ?? ""),
      ),
  );

  if (banned) {
    return {
      state: "fail",
      detail: "Remove the direct Wrangler dependency. cf is not required by this check.",
    };
  }

  const invalid = DEPENDENCY_SECTIONS.some(
    (section) => manifest[section] !== undefined && !Scripts.safeParse(manifest[section]).success,
  );

  const scripts = ConfigObjectSchema.safeParse(
    manifest.scripts === undefined ? {} : manifest.scripts,
  );

  const commands = scripts.success
    ? Object.entries(scripts.data).map(([name, source]) => {
        const text = z.string().safeParse(source);

        const outcome: CheckOutcome = text.success
          ? inspectCommand(text.data)
          : { state: "unknown", detail: "Package script must be a string." };

        return { ...outcome, detail: outcome.detail ? `scripts.${name}: ${outcome.detail}` : null };
      })
    : [];

  return summarize([
    ...commands,
    ...(invalid || !scripts.success
      ? [
          {
            state: "unknown" as const,
            detail: "Package scripts or dependency sections could not be read.",
          },
        ]
      : []),
  ]);
}

function inspectSteps(value: ConfigValue | undefined): CheckOutcome[] {
  const steps = z.array(ConfigObjectSchema).safeParse(value);

  if (!steps.success) {
    return [{ state: "unknown", detail: "Workflow or composite action steps could not be read." }];
  }

  return steps.data.flatMap((step) => {
    const outcomes: CheckOutcome[] = [];
    const use = z.string().safeParse(step.uses).data;

    if (use && /^cloudflare\/wrangler-action(?:\/[^@]+)?@/iu.test(use)) {
      outcomes.push({
        state: "fail",
        actual: use,
        detail: "Replace cloudflare/wrangler-action with a cf-based workflow.",
      });
    }

    if (step.run !== undefined) {
      const run = z.string().safeParse(step.run);

      outcomes.push(
        run.success
          ? inspectCommand(run.data)
          : { state: "unknown", detail: "A run command is not a string." },
      );
    }

    if (step.parallel !== undefined) {
      outcomes.push(...inspectSteps(step.parallel));
    }

    return outcomes;
  });
}

function inspectWorkflow(config: ConfigDocument, composite: boolean): CheckOutcome {
  if (composite) {
    const runs = ConfigObjectSchema.safeParse(config.runs);

    if (!runs.success) {
      return { state: "unknown", detail: "Action execution configuration could not be read." };
    }

    return runs.data.using === "composite"
      ? summarize(inspectSteps(runs.data.steps))
      : { state: "pass" };
  }

  const jobs = z.record(z.string(), ConfigObjectSchema).safeParse(config.jobs);

  if (!jobs.success) {
    return { state: "unknown", detail: "Workflow jobs could not be read." };
  }

  return summarize(
    Object.values(jobs.data).flatMap((job) =>
      job.uses !== undefined
        ? [
            {
              state: "unknown" as const,
              detail: "Reusable workflow usage requires review for Wrangler.",
            },
          ]
        : inspectSteps(job.steps),
    ),
  );
}

function manifestPath(path: string): boolean {
  return path === "package.json" || path.endsWith("/package.json");
}

function relevantPath(path: string): boolean {
  return (
    manifestPath(path) ||
    /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path) ||
    /(?:^|\/)action\.ya?ml$/u.test(path)
  );
}

function inspectFile(snapshot: RepoSnapshot, path: string): CheckOutcome {
  const file = readConfigFile(snapshot, path, manifestPath(path) ? "json" : "yaml");

  if (file.status !== "available") {
    return {
      state: "unknown",
      path,
      detail: file.status === "unavailable" ? file.detail : "Tracked file could not be read.",
    };
  }

  const config = ConfigObjectSchema.safeParse(file.value);

  if (!config.success) {
    return { state: "unknown", path, detail: "Expected a configuration object." };
  }

  const outcome = manifestPath(path)
    ? inspectManifest(config.data)
    : inspectWorkflow(config.data, !path.startsWith(".github/workflows/"));

  return { ...outcome, path };
}

export function inspectNoWrangler(snapshot: RepoSnapshot): CheckOutcome {
  if (!snapshot.tree) {
    return {
      state: "unknown",
      detail: snapshot.treeError ?? "Repository inventory is unavailable.",
    };
  }

  const outcomes = [...snapshot.tree.paths]
    .filter(relevantPath)
    .toSorted()
    .map((path) => inspectFile(snapshot, path));

  if (snapshot.tree.truncated) {
    outcomes.push({ state: "unknown", detail: "Repository inventory was truncated." });
  }

  const result = summarize(outcomes);

  return result.state === "pass"
    ? {
        state: "pass",
        detail:
          "No direct Wrangler dependencies or explicit CLI usage found in tracked manifests, workflows, and composite actions. cf is not required.",
      }
    : result;
}
