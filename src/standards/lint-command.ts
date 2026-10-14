import { z } from "zod";
import type { TraversalBudget } from "./lint-config";
import type { ConfigDocument } from "./config-value";

export interface LintCommand {
  configs: Array<string | null>;
  uncertain: boolean;
}

/** Recognize only check commands with unchanged cwd and no shell control flow. */
export function inspectLintCommand(
  command: string,
  scripts: Readonly<ConfigDocument>,
  visiting = new Set<string>(),
  budget?: TraversalBudget,
): LintCommand {
  const traversal = budget ?? { remaining: 64 };

  if (
    !/^[\w@./:= -]+(?:&&[\w@./:= -]+)*$/.test(command) ||
    visiting.size >= 16 ||
    traversal.remaining <= 0
  ) {
    return { configs: [], uncertain: true };
  }

  traversal.remaining -= 1;

  const result: LintCommand = { configs: [], uncertain: false };

  for (const part of new Set(command.split("&&").map((value) => value.trim()))) {
    if (traversal.remaining <= 0 || result.configs.length >= 64) {
      result.uncertain = true;
      break;
    }

    const alias = /^(?:npm run|pnpm(?: run)?|yarn(?: run)?) ([\w:-]+)$/.exec(part);

    if (alias) {
      const name = alias[1];
      const script = z.string().safeParse(scripts[name]).data;

      if (visiting.has(name) || script === undefined) {
        result.uncertain = true;
        continue;
      }

      const child = inspectLintCommand(script, scripts, new Set([...visiting, name]), traversal);
      result.configs.push(...child.configs);
      result.uncertain ||= child.uncertain;
      continue;
    }

    const invocation = /^(?:(?:pnpm exec|npm exec --|yarn exec) )?oxlint(?: (.*))?$/.exec(part);

    if (!invocation) {
      result.uncertain = true;
      continue;
    }

    const args = invocation[1]?.trim().split(/ +/) ?? [];
    let config: string | null = null;
    let valid = true;

    for (let index = 0; index < args.length; index++) {
      const arg = args[index];

      if (arg === "--config" || arg === "-c" || arg.startsWith("--config=")) {
        const selected = arg.startsWith("--config=") ? arg.slice(9) : args[++index];

        if (
          config !== null ||
          !selected ||
          !/^[\w@./-]+$/.test(selected) ||
          selected.startsWith("-")
        ) {
          valid = false;
        } else {
          config = selected;
        }
      } else if (
        ![
          "--type-aware",
          "--type-check",
          "--deny-warnings",
          "--report-unused-disable-directives",
        ].includes(arg) &&
        !/^[\w./]+$/.test(arg)
      ) {
        valid = false;
      }
    }

    if (valid) {
      result.configs.push(config);
    } else {
      result.uncertain = true;
    }
  }

  return { ...result, configs: [...new Set(result.configs)] };
}
