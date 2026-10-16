import { z } from "zod";
import type { CheckOutcome } from "./checks/result";
import { joinPath } from "./lint-config";
import { readConfigFile } from "./repository-files";
import type { Check } from "./schema";
import type { RepoSnapshot } from "./snapshot";

const Manifest = z.object({
  scripts: z.record(z.string(), z.string()).default({}),
  dependencies: z.record(z.string(), z.string()).default({}),
  devDependencies: z.record(z.string(), z.string()).default({}),
});

type PackageManifest = z.infer<typeof Manifest>;

type LocalCliCheck = Extract<Check, { type: "portless-dev" | "cloudflare-cf-cli" }>;

type Invocation = "portless" | "web" | "unknown";

const LOCAL_RUNNER = /^(?:(?:pnpm|yarn) exec |npm exec -- |bun x )/u;

/** Resolve only simple aliases and commands; repository scripts are never executed. */
function devInvocation(
  source: string,
  scripts: Readonly<Record<string, string>>,
  visited: string[] = [],
): Invocation {
  const command = source
    .trim()
    .replaceAll(/[ \t]+/gu, " ")
    .replace(/^exec /u, "");

  if (!command || !/^[\w@./:= -]+$/u.test(command)) {
    return "unknown";
  }

  const alias = /^(?:npm run |(?:pnpm|yarn|bun) (?:run )?)([\w:.-]+)$/u.exec(command)?.[1];

  if (alias && Object.hasOwn(scripts, alias)) {
    return visited.includes(alias) || visited.length >= 8
      ? "unknown"
      : devInvocation(scripts[alias], scripts, [...visited, alias]);
  }

  const binary = command.replace(LOCAL_RUNNER, "");
  const portless = /^portless run (.+)$/u.exec(binary)?.[1];

  if (portless) {
    // Portless must wrap a web server, rather than help/version or a setup task.
    return webServer(portless) ? "portless" : "unknown";
  }

  return webServer(binary) ? "web" : "unknown";
}

function webServer(command: string): boolean {
  return (
    /^(?:vite(?: dev| serve)?(?= -|$)|(?:next|astro|nuxt|react-router|cf|wrangler) dev)(?: |$)/u.test(
      command,
    ) && !/(?:^| )(?:--help|--version|-h|-v)(?: |$)/u.test(command)
  );
}

function inspectPortless(manifest: PackageManifest): CheckOutcome {
  const dev = manifest.scripts.dev;

  if (dev === undefined) {
    return { state: "pass", detail: "No scripts.dev declared; no default web server to check." };
  }

  const invocation = devInvocation(dev, manifest.scripts);

  if (invocation === "unknown") {
    return {
      state: "unknown",
      detail: "Review scripts.dev: indirect, custom, or compound development commands need review.",
    };
  }

  if (invocation === "web") {
    return { state: "fail", detail: "Wrap the default web dev command with portless run." };
  }

  return manifest.devDependencies.portless?.trim()
    ? { state: "pass", detail: "scripts.dev uses portless run and declares a local devDependency." }
    : { state: "fail", detail: "Install portless as a local devDependency." };
}

function inspectCloudflare(
  manifest: PackageManifest,
  check: LocalCliCheck,
  snapshot: RepoSnapshot,
): CheckOutcome {
  const cliNames = ["cf", "wrangler"];

  const declared = cliNames.some(
    (name) =>
      Object.hasOwn(manifest.dependencies, name) || Object.hasOwn(manifest.devDependencies, name),
  );

  const configs = ["cloudflare.config.ts", "wrangler.jsonc", "wrangler.json", "wrangler.toml"];

  const configured = configs.some((name) =>
    snapshot.tree?.paths.has(joinPath(check.directory, name)),
  );

  if (!declared && !configured) {
    return snapshot.tree && !snapshot.tree.truncated
      ? {
          state: "pass",
          detail: "No Cloudflare CLI dependency or configuration found in this directory.",
        }
      : { state: "unknown", detail: "Incomplete inventory cannot exclude a Cloudflare project." };
  }

  if (
    Object.hasOwn(manifest.dependencies, "wrangler") ||
    Object.hasOwn(manifest.devDependencies, "wrangler")
  ) {
    return {
      state: "fail",
      detail: "Replace the direct Wrangler dependency with cf in devDependencies.",
    };
  }

  return manifest.devDependencies.cf?.trim()
    ? {
        state: "pass",
        detail:
          "Cloudflare CLI cf is a local devDependency. Script and deployment behavior are not checked.",
      }
    : { state: "fail", detail: "Install cf as a local devDependency for this Cloudflare project." };
}

export function inspectLocalCli(check: LocalCliCheck, snapshot: RepoSnapshot): CheckOutcome {
  const path = joinPath(check.directory, "package.json");
  const file = readConfigFile(snapshot, path, "json");

  if (file.status !== "available") {
    return {
      state: file.status === "missing" ? "fail" : "unknown",
      path,
      detail: file.status === "missing" ? "The package manifest is missing." : file.detail,
    };
  }

  const manifest = Manifest.safeParse(file.value);

  if (!manifest.success) {
    return { state: "unknown", path, detail: "Package scripts or dependencies could not be read." };
  }

  const outcome =
    check.type === "portless-dev"
      ? inspectPortless(manifest.data)
      : inspectCloudflare(manifest.data, check, snapshot);

  return { ...outcome, path };
}
