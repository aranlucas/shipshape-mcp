type Invocation = "invoked" | "absent" | "unknown";

type Target = "husky" | "lint-staged";

type Scripts = Readonly<Record<string, string>>;

const RUNNER =
  /^(?:(?:pnpm|yarn) exec |npm exec (?:-- )?|npx (?:--no-install )?|bunx |bun x |(?:pnpm|yarn|bun) (?:run )?)/u;

const LINT_FLAGS =
  /^(?:(?:--(?:verbose|quiet|debug|no-stash|no-hide-partially-staged|hide-unstaged|hide-all|fail-on-changes|allow-empty|continue-on-error)|-[dq])|(?:--concurrent|-p) (?:false|true|\d+)|--max-arg-length \d+)$/u;

function directInvocation(command: string, target: Target): Invocation {
  const binary = command.replace(RUNNER, "");

  if (target === "husky") {
    return /^(?:husky|husky install)$/u.test(binary) ? "invoked" : "unknown";
  }

  if (binary === "lint-staged") {
    return "invoked";
  }

  if (!binary.startsWith("lint-staged ")) {
    return "unknown";
  }

  const args = binary.slice("lint-staged ".length);

  if (/(?:^| )(?:--help|--version|-h|-V)(?: |$)/u.test(args)) {
    return "absent";
  }

  // Config/cwd/diff selectors and unrecognized flags may change which tasks or
  // files are checked. Do not infer their meaning from a matching binary name.
  return args.split(/ (?=-)/u).every((flag) => LINT_FLAGS.test(flag)) ? "invoked" : "unknown";
}

function firstCommand(
  source: string,
  target: Target,
  scripts: Scripts,
  visited: string[],
): Invocation {
  const line = target === "husky" ? source.replace(/\s*\|\|\s*true$/u, "") : source;

  if (!/^[\w@./:\s&-]+$/u.test(line) || line.replaceAll("&&", "").includes("&")) {
    return "unknown";
  }

  const chain = line.split("&&").map((part) => part.trim());

  if (chain.some((part) => !part)) {
    return "unknown";
  }

  const command = chain[0]
    .replace(/^exec\s+/u, "")
    .split(/\s+/u)
    .join(" ");

  const scriptCall =
    /^(?:npm run |(?:pnpm|yarn|bun) (?:run )?)(?!exec(?: |$)|x(?: |$))([\w:.-]+)(?: (.+))?$/u.exec(
      command,
    );

  const alias = scriptCall?.[1];

  // pnpm/yarn/bun shorthand prefers a package script over the local binary.
  if (alias && Object.hasOwn(scripts, alias)) {
    if (scriptCall?.[2] || visited.length >= 8 || visited.includes(alias)) {
      return "unknown";
    }

    return inspectCommand(scripts[alias], target, scripts, false, [...visited, alias]);
  }

  if (command.startsWith("pnpm run ")) {
    return "unknown";
  }

  return directInvocation(command, target);
}

/** A bounded recognizer, not a shell interpreter. No repository code is run. */
export function inspectCommand(
  text: string,
  target: Target,
  scripts: Scripts,
  hook = false,
  visited: string[] = [],
): Invocation {
  const lines = text
    .split(/\r?\n/u)
    .map((line) =>
      line
        .trim()
        .replace(/(?:^|\s+)#.*$/u, "")
        .trim(),
    )
    .filter(Boolean);

  if (!lines.length) {
    return "absent";
  }

  // Husky runs user hooks with sh -e. Package scripts generally do not: a
  // later command on a new line can swallow the target command's failure.
  if (!hook && lines.length > 1) {
    return "unknown";
  }

  const active = lines.filter((line) => !hook || !/^set -e(?:u)?$/u.test(line));
  const first = active[0];

  if (!first) {
    return "absent";
  }

  if (/^(?:exit|return)\b/u.test(first)) {
    return "absent";
  }

  // A failed non-final command in an AND list is exempt from sh -e. A later
  // line may then succeed and hide the failure of `lint-staged && another`.
  if (hook && first.includes("&&") && active.length > 1) {
    return "unknown";
  }

  // Only a proven first command can establish invocation. Unknown setup may
  // change directories, disable errexit, redefine commands or exit early.
  return firstCommand(first, target, scripts, visited);
}
