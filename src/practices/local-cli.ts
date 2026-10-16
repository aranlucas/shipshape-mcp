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

type LocalCliCheck = Extract<Check, { type: "portless-dev" }>;

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

  const outcome = inspectPortless(manifest.data);

  return { ...outcome, path };
}
