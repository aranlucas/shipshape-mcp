import { z } from "zod";
import type { CheckResult, Evidence } from "../domain/types";
import { requireRuleDefinition } from "../domain/rules";
import { configObject, type ConfigDocument, type ConfigValue } from "../standards/config-value";
import { evaluateStandards, type StandardsSource } from "../standards/evaluate";
import { joinPath, parentPath, parseConfig } from "../standards/lint-config";
import { parseYaml } from "../standards/policy";
import type { ReviewFinding, ReviewState } from "./types";

const excludedPath =
  /(^|\/)(node_modules|vendor|vendored|third_party|third-party|dist|build|coverage|generated|__generated__|\.next|\.nuxt|\.output|\.git)(\/|$)/i;

const updaterPath =
  /^(\.github\/dependabot\.ya?ml|renovate\.json5?|\.renovaterc(?:\.json)?|\.github\/renovate\.json5?)$/;

const dependencySections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const MAX_PACKAGES = 20;

const MAX_DETAILS = 1_400;

interface PackageContext {
  source: StandardsSource;
  path: string;
  manifestPath: string;
  manifest: ConfigDocument | null;
  paths: string[];
  dependencies: Declaration[];
}

interface Declaration {
  name: string;
  version: string;
  section: string;
}

const short = (value: string) =>
  value.length > MAX_DETAILS ? `${value.slice(0, MAX_DETAILS)}…` : value;

const text = (value: ConfigValue | undefined) => z.string().safeParse(value).data ?? null;

function evidence(source: StandardsSource, paths: string[]): Evidence[] {
  const selected = [...new Set(paths)].slice(0, 8);

  return (selected.length ? selected : ["."]).map((path) => ({
    url:
      path !== "." && Object.hasOwn(source.files, path)
        ? `https://github.com/${source.repository}/blob/${source.commit}/${path.split("/").map(encodeURIComponent).join("/")}`
        : `https://github.com/${source.repository}/tree/${source.commit}`,
    label: path === "." ? "Pinned repository tree" : path,
  }));
}

function card(
  context: PackageContext,
  key: string,
  title: string,
  state: ReviewState,
  current: string,
  desired: string,
  nextStep: string,
  paths: string[],
  category: ReviewFinding["category"] = "standards",
): ReviewFinding {
  return {
    id: `${context.source.repository}:${context.path}:${key}`,
    repository: context.source.repository,
    category,
    title: `${context.path}: ${title}`,
    state,
    priority: "low",
    confidence: state === "unknown" ? "low" : "medium",
    current: short(current),
    desired,
    nextStep,
    evidence: evidence(context.source, paths),
    approvalRequired: true,
  };
}

function baselineCard(source: StandardsSource, path: string, check: CheckResult): ReviewFinding {
  const state =
    check.state === "pass" ? "observed" : check.state === "fail" ? "needs_review" : check.state;

  const current = [...new Set(check.evidence.map((item) => item.detail).filter(Boolean))].join(" ");

  return {
    id: `${source.repository}:${path}:${check.ruleId}`,
    repository: source.repository,
    category: "standards",
    title: `${path}: ${check.title}`,
    state,
    priority: check.priority,
    confidence: check.confidence,
    current: short(
      `Static check: ${check.state}. ${current || check.remediation}${check.ruleId === "standards.updates" ? updaterSummary(source) : ""}`,
    ),
    desired: requireRuleDefinition(check.ruleId).remediation,
    nextStep:
      check.state === "not_applicable"
        ? "Keep the documented exception or applicability decision; reassess before its expiry or when the package changes."
        : check.state === "pass"
          ? "Review the pinned declaration and verify behavior through the repository's normal checks before proposing changes."
          : check.remediation,
    evidence: check.evidence.length ? check.evidence : evidence(source, ["."]),
    approvalRequired: true,
  };
}

function updaterSummary(source: StandardsSource): string {
  const summaries = Object.keys(source.files)
    .filter((path) => updaterPath.test(path))
    .slice(0, 6)
    .map((path) => {
      const contents = source.files[path];

      if (contents === null || contents === undefined) {
        return `${path}: contents unavailable`;
      }

      try {
        const config = /\.ya?ml$/.test(path)
          ? configObject(parseYaml(contents))
          : parseConfig(contents);

        if (!config) {
          return `${path}: dynamic or unsupported configuration requires inspection`;
        }

        const updates = Array.isArray(config.updates) ? config.updates : [];

        const ecosystems = updates
          .map((update) => {
            const item = configObject(update);

            return `${text(item["package-ecosystem"]) ?? "unknown ecosystem"} at ${text(item.directory) ?? "unspecified directory"}`;
          })
          .slice(0, 8);

        const packageRules = Array.isArray(config.packageRules) ? config.packageRules.length : 0;

        return `${path}: ${ecosystems.length ? ecosystems.join(", ") : `${packageRules} local package rules`}; inherited rules, coverage, and scheduling are not verified`;
      } catch {
        return `${path}: unreadable configuration`;
      }
    });

  return summaries.length ? ` Read configuration: ${summaries.join("; ")}.` : "";
}

function declarations(manifest: ConfigDocument | null): Declaration[] {
  return dependencySections
    .flatMap((section) =>
      Object.entries(configObject(manifest?.[section])).flatMap(([name, value]) => {
        const version = text(value);

        return version === null ? [] : [{ name, version, section }];
      }),
    )
    .toSorted((a, b) => `${a.name}:${a.section}`.localeCompare(`${b.name}:${b.section}`));
}

function packageContexts(source: StandardsSource): PackageContext[] {
  const paths = Object.keys(source.files)
    .filter((path) => !excludedPath.test(path))
    .toSorted();

  const manifests = paths.filter((path) => /(^|\/)package\.json$/.test(path));
  const directories = new Set(manifests.map(parentPath));
  const filesByPackage = new Map<string, string[]>();

  for (const file of paths) {
    let owner = parentPath(file);

    while (!directories.has(owner) && owner !== ".") {
      owner = parentPath(owner);
    }

    if (directories.has(owner)) {
      const owned = filesByPackage.get(owner) ?? [];
      owned.push(file);
      filesByPackage.set(owner, owned);
    }
  }

  return manifests.slice(0, MAX_PACKAGES).map((manifestPath) => {
    const path = parentPath(manifestPath);
    const manifest = parseConfig(source.files[manifestPath]);

    return {
      source,
      path,
      manifestPath,
      manifest,
      paths: filesByPackage.get(path) ?? [],
      dependencies: declarations(manifest),
    };
  });
}

/** Literal hints only: comments are skipped; JavaScript is never evaluated. */
function literalHints(contents: string): string[] {
  const tokens =
    contents.match(
      /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    ) ?? [];

  return tokens
    .filter((token) => /^["'`]/.test(token) && !token.includes("${"))
    .map((token) => token.slice(1, -1));
}

function testConvention(
  context: PackageContext,
  framework: "vitest" | "playwright",
): ReviewFinding {
  const directory = framework === "vitest" ? "test" : "e2e";

  const configPaths = context.paths.filter((path) =>
    new RegExp(
      `(^|/)${framework === "vitest" ? "(?:vitest|vite)" : "playwright"}\\.config\\.[cm]?[jt]s$`,
    ).test(path),
  );

  const scriptValues = Object.values(configObject(context.manifest?.scripts)).flatMap(
    (value) => text(value) ?? [],
  );

  const explicitConfig = configPaths.some((path) => path.includes(`${framework}.config.`));

  const declared =
    context.dependencies.some(({ name }) =>
      framework === "vitest"
        ? name === "vitest"
        : name === "@playwright/test" || name === "playwright",
    ) ||
    explicitConfig ||
    scriptValues.some((script) => new RegExp(`\\b${framework}\\b`).test(script));

  const prefix = `${context.path === "." ? "" : `${context.path}/`}${directory}/`;
  const testPaths = context.paths.filter((path) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path));
  const conventional = testPaths.filter((path) => path.startsWith(prefix));
  const readable = configPaths.filter((path) => context.source.files[path] !== null);

  const hints = readable
    .flatMap((path) =>
      literalHints(context.source.files[path] ?? "")
        .filter((literal) => new RegExp(`^(?:\\./)?${directory}(?:/|$)`).test(literal))
        .map((literal) => `${path}: ${literal}`),
    )
    .slice(0, 6);

  const uncertain =
    !context.manifest ||
    !context.source.complete ||
    readable.length !== configPaths.length ||
    context.source.unreadablePaths?.some(
      (path) =>
        path.startsWith(context.path === "." ? "" : `${context.path}/`) &&
        path.includes(`${framework}.config.`),
    );

  const state = !declared
    ? uncertain
      ? "unknown"
      : "not_applicable"
    : uncertain
      ? "unknown"
      : conventional.length
        ? "observed"
        : "needs_review";

  return card(
    context,
    `standards.${framework}-convention`,
    `${framework === "vitest" ? "Vitest test/" : "Playwright e2e/"} convention`,
    state,
    `${declared ? `${framework} is declared or referenced` : `No direct ${framework} declaration was found`}; ${conventional.length} test/spec paths under ${directory}/ in this package. ${hints.length ? `Config literal hints: ${hints.join("; ")}.` : "No literal config hint for that directory was collected."} Config selection, effective includes/excludes, test quality, and execution are not verified.`,
    `${framework === "vitest" ? "Keep meaningful behavior unit tests under test/ with deliberate source-import resolution." : "Keep applicable browser journeys under e2e/ and select them in Playwright configuration."} Preserve justified package-specific conventions.`,
    declared
      ? `Inspect runner configuration and test coverage before proposing a ${directory}/ migration; retain meaningful behavior tests and run the appropriate checks after approval.`
      : `Confirm whether ${framework} applies before proposing a runner or directory change.`,
    [context.manifestPath, ...configPaths, ...conventional.slice(0, 3)],
  );
}

function sourceAliases(context: PackageContext): ReviewFinding {
  const path = joinPath(context.path, "tsconfig.json");
  const config = parseConfig(context.source.files[path]);
  const options = configObject(config?.compilerOptions);

  const aliases = Object.entries(configObject(options.paths))
    .flatMap(([name, values]) =>
      (z.array(z.string()).safeParse(values).data ?? [])
        .filter((value) => /^(?:\.\/)?src(?:\/|$)/.test(value))
        .map((value) => `${name} → ${value}`),
    )
    .slice(0, 10);

  const hasSource = context.paths.some(
    (file) => file.startsWith(joinPath(context.path, "src/")) && /\.[cm]?[jt]sx?$/.test(file),
  );

  const uncertain =
    !config ||
    !context.source.complete ||
    config.extends !== undefined ||
    options.baseUrl !== undefined;

  return card(
    context,
    "standards.source-aliases",
    "Source import aliases",
    !hasSource && context.source.complete
      ? "not_applicable"
      : uncertain
        ? "unknown"
        : aliases.length
          ? "observed"
          : "needs_review",
    `${aliases.length ? `Local TypeScript path declarations: ${aliases.join(", ")}.` : "No local src/ alias declaration was collected."} Inherited settings, baseUrl, runtime/test resolution, and actual imports are not verified.`,
    "Use deliberate source aliases consistently across TypeScript and applicable test/build tools, with documented exceptions.",
    "Inspect effective compiler and runner resolution before proposing alias changes; do not rewrite imports from declaration evidence alone.",
    [context.manifestPath, path],
  );
}

function workflowConfiguration(source: StandardsSource) {
  return Object.keys(source.files)
    .filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path))
    .map((path) => {
      try {
        const contents = source.files[path];

        return { path, config: contents === null ? null : configObject(parseYaml(contents)) };
      } catch {
        return { path, config: null };
      }
    });
}

function inspectSetupRun(run: string, alreadySetup: boolean) {
  let setup = alreadySetup;
  let install = false;

  for (const line of run.split("\n").map((part) => part.trim())) {
    if (line === "corepack enable") {
      setup = true;
    }

    if (
      setup &&
      /^pnpm (?:install|i)\s+.*--frozen-lockfile(?:\s|$)/.test(line) &&
      !/--no-frozen-lockfile|--frozen-lockfile=false/.test(line)
    ) {
      install = true;
    }
  }

  return { setup, install };
}

function pnpmConfiguration(context: PackageContext): ReviewFinding {
  const manager = text(context.manifest?.packageManager);

  const usesPnpm =
    manager?.startsWith("pnpm@") === true ||
    context.paths.some((path) => /(^|\/)pnpm-lock\.yaml$/.test(path));

  const workflows = workflowConfiguration(context.source);
  const setup: string[] = [];
  const install: string[] = [];
  const lockedSetup: string[] = [];

  for (const workflow of workflows) {
    for (const [name, rawJob] of Object.entries(configObject(workflow.config?.jobs))) {
      const job = configObject(rawJob);
      let setupSeen = false;

      for (const rawStep of Array.isArray(job.steps) ? job.steps : []) {
        const step = configObject(rawStep);
        const action = text(step.uses) ?? "";
        const run = text(step.run) ?? "";

        if (action.startsWith("pnpm/action-setup@") || action.startsWith("pnpm/setup@")) {
          setupSeen = true;
          setup.push(`${workflow.path} (${name})`);
        }

        const requireLockfile = configObject(step.with)["require-lockfile"];

        if (
          action.startsWith("pnpm/setup@") &&
          (requireLockfile === true || requireLockfile === "true")
        ) {
          lockedSetup.push(`${workflow.path} (${name})`);
        }

        const sequence = inspectSetupRun(run, setupSeen);

        if (sequence.setup && !setupSeen) {
          setup.push(`${workflow.path} (${name})`);
        }

        setupSeen = sequence.setup;

        if (sequence.install) {
          install.push(`${workflow.path} (${name})`);
        }
      }
    }
  }

  const state =
    !context.manifest || !context.source.complete
      ? "unknown"
      : !usesPnpm
        ? "not_applicable"
        : manager?.startsWith("pnpm@") && (install.length || lockedSetup.length)
          ? "observed"
          : "unknown";

  return card(
    context,
    "standards.pnpm-setup",
    "pnpm and CI setup",
    state,
    `packageManager: ${manager ?? "not declared/readable"}. ${setup.length ? `Setup text found in ${[...new Set(setup)].slice(0, 4).join(", ")}.` : "No direct pnpm setup step was recognized."} ${lockedSetup.length ? "Combined pnpm/setup declares require-lockfile: true." : install.length ? "A later frozen-lockfile install is declared in the same job." : "No setup-then-frozen-install sequence or explicitly locked pnpm/setup was recognized."} Workflow conditions, version resolution, workspace scope, reusable actions, and execution are not verified.`,
    "For pnpm packages, declare the intended package-manager version and set it up before a locked CI install.",
    usesPnpm
      ? "Inspect the applicable CI job, packageManager pin, and workspace lockfile before proposing setup changes; verify actual runs separately."
      : "Confirm the intended package manager; retain the current ecosystem unless a migration is approved.",
    [context.manifestPath, ...workflows.map((workflow) => workflow.path)],
  );
}

const dependencyGroups = [
  {
    key: "react",
    title: "React and framework",
    includes: (name: string) => /^(react|react-dom|next|@types\/react(?:-dom)?)$/.test(name),
  },
  {
    key: "vite-vitest",
    title: "Vite and Vitest",
    includes: (name: string) =>
      /^(?:vite|vitest|@cloudflare\/(?:vite|vitest)-plugin)$|^@(?:vitest|vitejs)\//.test(name),
  },
  {
    key: "oxforge",
    title: "Oxforge and Oxc",
    includes: (name: string) =>
      /^(?:@aranlucas\/oxforge|oxlint|oxlint-tsgolint|oxfmt|@oxlint\/.*)$/.test(name),
  },
  {
    key: "playwright",
    title: "Playwright",
    includes: (name: string) => /^(?:@playwright\/test|playwright(?:-core)?)$/.test(name),
  },
  {
    key: "cloudflare",
    title: "Cloudflare runtime and tooling",
    includes: (name: string) => /^(?:cf|wrangler|agents|miniflare|@cloudflare\/.*)$/.test(name),
  },
  {
    key: "mcp",
    title: "Model Context Protocol",
    includes: (name: string) => name.startsWith("@modelcontextprotocol/"),
  },
];

function relatedDependencies(context: PackageContext): ReviewFinding[] {
  return dependencyGroups.flatMap((group) => {
    const members = context.dependencies.filter(({ name }) => group.includes(name));

    if (new Set(members.map(({ name }) => name)).size < 2) {
      return [];
    }

    return [
      card(
        context,
        `dependencies.related.${group.key}`,
        `${group.title} compatibility review`,
        "observed",
        `Declared versions: ${members
          .slice(0, 16)
          .map(({ name, version, section }) => `${name} ${version} (${section})`)
          .join(
            "; ",
          )}.${members.length > 16 ? ` ${members.length - 16} additional declarations omitted.` : ""} These are manifest declarations, not installed or resolved versions; no compatibility or latest-version claim is made.`,
        "Review related dependency updates together against peer requirements, release notes, lockfile resolution, and meaningful tests.",
        "Prepare a compatible grouped update only after checking the exact release requirements; preserve package-specific constraints and request approval before repository changes.",
        [
          context.manifestPath,
          ...Object.keys(context.source.files).filter((path) => updaterPath.test(path)),
        ],
        "dependencies",
      ),
    ];
  });
}

function cleanupReviews(context: PackageContext): ReviewFinding[] {
  const scripts = Object.entries(configObject(context.manifest?.scripts)).flatMap(
    ([name, value]) => (text(value) === null ? [] : [name]),
  );

  const common =
    "No entrypoint-aware usage graph was collected. Static declarations do not establish that anything is unused.";

  return [
    card(
      context,
      "cleanup.scripts",
      "Script usage review",
      "unknown",
      `${scripts.length} scripts declared${
        scripts.length ? `: ${scripts.slice(0, 16).join(", ")}` : ""
      }. ${common}`,
      "Keep useful developer, release, CI, and public command entrypoints; remove only confirmed redundant scripts.",
      "Trace scripts through CI, documentation, lifecycle hooks, and external callers before proposing any removal.",
      [context.manifestPath],
      "cleanup",
    ),
    card(
      context,
      "cleanup.dead-code",
      "Dead-code review",
      "unknown",
      common,
      "Remove only confirmed unreachable implementation while retaining public APIs, diagnostics, and meaningful behavior unit tests.",
      "Build an entrypoint-aware graph covering exports, CLI/plugin hooks, dynamic loading, and tests; review candidates individually and verify behavior before proposing removal.",
      [context.manifestPath],
      "cleanup",
    ),
    card(
      context,
      "cleanup.unused-dependencies",
      "Unused-dependency review",
      "unknown",
      `${context.dependencies.length} dependency declarations collected. ${common}`,
      "Remove dependencies only when runtime, build, test, peer, optional, and tool entrypoints are accounted for.",
      "Inspect usage with entrypoint-aware tooling and review dynamic imports, peer contracts, and CLI/config plugins before proposing dependency removal.",
      [context.manifestPath],
      "cleanup",
    ),
  ];
}

const relevant = (path: string) =>
  /(^|\/)(package\.json|go\.mod|pyproject\.toml|tsconfig\.json|(?:vitest|vite|playwright)\.config\.[cm]?[jt]s)$/.test(
    path,
  ) ||
  /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) ||
  updaterPath.test(path);

function collectionCoverage(source: StandardsSource, audited: string[]): ReviewFinding[] {
  const paths = Object.keys(source.files).filter((path) => !excludedPath.test(path));

  const manifests = paths.filter((path) =>
    /(^|\/)(package\.json|go\.mod|pyproject\.toml)$/.test(path),
  );

  const omitted = [...new Set(manifests.map(parentPath))].filter((path) => !audited.includes(path));

  const nodeOmitted = Math.max(
    0,
    manifests.filter((path) => /(^|\/)package\.json$/.test(path)).length - MAX_PACKAGES,
  );

  const unavailable = [
    ...new Set([
      ...paths.filter((path) => relevant(path) && source.files[path] === null),
      ...(source.unreadablePaths ?? []).filter(
        (path) => !excludedPath.test(path) && relevant(path),
      ),
    ]),
  ];

  if (source.complete && !omitted.length && !nodeOmitted && !unavailable.length) {
    return [];
  }

  return [
    {
      id: `${source.repository}:standards.collection-coverage`,
      repository: source.repository,
      category: "standards",
      title: "Static collection coverage",
      state: "unknown",
      priority: "low",
      confidence: "low",
      current: short(
        `Repository tree ${source.complete ? "complete" : "incomplete or unavailable"}. ${omitted.length} discovered package directories omitted from the bounded baseline audit; ${nodeOmitted} Node packages beyond the ${MAX_PACKAGES}-package extra-review limit. ${unavailable.length} selected config/manifest paths unreadable, oversized, symlinked, or outside the content budget${unavailable.length ? `: ${unavailable.slice(0, 8).join(", ")}` : ""}.`,
      ),
      desired:
        "Treat uncovered files and packages as unknown; inspect them before concluding repository-wide alignment.",
      nextStep:
        "Review omitted packages and unreadable configuration in a separately scoped inspection. The collector never bulk-reads source or executes repository commands.",
      evidence: evidence(source, [
        ...unavailable,
        ...omitted.map((path) => joinPath(path, "package.json")),
      ]),
      approvalRequired: true,
    },
  ];
}

/** Reuse package rule states and exceptions, then add bounded, read-only review evidence. */
export function evaluateReviewStandards(source: StandardsSource): ReviewFinding[] {
  const reviewSource: StandardsSource = {
    ...source,
    files: Object.fromEntries(
      Object.entries(source.files).filter(([path]) => !excludedPath.test(path)),
    ),
    unreadablePaths: source.unreadablePaths?.filter((path) => !excludedPath.test(path)),
    policy: {
      ...source.policy,
      packages: source.policy.packages.filter((pkg) => !excludedPath.test(pkg.path)),
      exceptions: source.policy.exceptions.filter((item) => !excludedPath.test(item.path)),
    },
  };

  const audit = evaluateStandards(reviewSource);

  const findings = audit.packages
    .filter((pkg) => !excludedPath.test(pkg.path))
    .flatMap((pkg) => pkg.audit.checks.map((check) => baselineCard(source, pkg.path, check)));

  findings.push(
    ...collectionCoverage(
      source,
      audit.packages.map((pkg) => pkg.path),
    ),
  );

  for (const exception of audit.expiredExceptions.filter((item) => !excludedPath.test(item.path))) {
    findings.push({
      id: `${source.repository}:${exception.path}:exception:${exception.rule}:${exception.expires}`,
      repository: source.repository,
      category: "standards",
      title: `${exception.path}: Expired ${exception.rule} exception`,
      state: "needs_review",
      priority: "medium",
      confidence: "high",
      current: `Exception expired ${exception.expires}: ${exception.reason}`,
      desired:
        "Resolve the underlying finding or explicitly approve a newly dated, justified exception.",
      nextStep:
        "Review the current package check and original rationale; do not silently extend the exception.",
      evidence: [
        ...evidence(source, [".shipshape.yml"]),
        ...(source.policyEvidence
          ? [{ url: source.policyEvidence, label: "Pinned shared policy" }]
          : []),
      ],
      approvalRequired: true,
    });
  }

  for (const context of packageContexts(source)) {
    findings.push(
      testConvention(context, "vitest"),
      testConvention(context, "playwright"),
      sourceAliases(context),
      pnpmConfiguration(context),
      ...relatedDependencies(context),
      ...cleanupReviews(context),
    );
  }

  return findings;
}
