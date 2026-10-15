import { parse, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { ConfigObjectSchema, configObject, type ConfigDocument } from "./config-value";

export const LINT_CONFIG_NAMES = [
  ".oxlintrc.json",
  ".oxlintrc.jsonc",
  "oxlint.config.ts",
  "oxlint.config.mts",
] as const;

export const lintConfigPath = (path: string) =>
  /(^|\/)(\.oxlintrc\.jsonc?|oxlint[^/]*\.jsonc?|oxlint\.config\.[cm]?ts)$/.test(path);

export const joinPath = (path: string, name: string) => (path === "." ? name : `${path}/${name}`);

export function parseConfig(text: string | null | undefined): ConfigDocument | null {
  if (text === null || text === undefined) {
    return null;
  }

  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });

  return errors.length ? null : (ConfigObjectSchema.safeParse(value).data ?? null);
}

export function parentPath(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
}

export function resolvePath(directory: string, relative: string): string | null {
  if (!/^[\w@./-]+$/.test(relative) || relative.startsWith("/")) {
    return null;
  }

  const parts = directory === "." ? [] : directory.split("/");

  for (const part of relative.split("/")) {
    if (part === "..") {
      if (!parts.length) {
        return null;
      }

      parts.pop();
    } else if (part && part !== ".") {
      parts.push(part);
    }
  }

  return parts.join("/") || null;
}

export interface TraversalBudget {
  remaining: number;
}

export interface LintGraph {
  preset: boolean;
  uncertain: boolean;
  missing: boolean;
  legacy: string[];
  paths: string[];
}

export function inspectLintConfig(
  files: Readonly<Record<string, string | null>>,
  path: string,
  complete: boolean,
  visiting = new Set<string>(),
  budget?: TraversalBudget,
): LintGraph {
  const traversal = budget ?? { remaining: 64 };

  const result: LintGraph = {
    preset: false,
    uncertain: false,
    missing: false,
    legacy: [],
    paths: [path],
  };

  if (visiting.has(path) || visiting.size >= 16 || traversal.remaining <= 0) {
    return { ...result, uncertain: true };
  }

  traversal.remaining -= 1;

  if (!Object.hasOwn(files, path)) {
    return { ...result, missing: complete, uncertain: !complete };
  }

  const config = /\.jsonc?$/.test(path) ? parseConfig(files[path]) : null;

  if (!config) {
    return { ...result, uncertain: true };
  }

  const overrides = z.array(ConfigObjectSchema).safeParse(config.overrides ?? []);
  result.uncertain = !overrides.success;

  for (const section of [config, ...(overrides.data ?? [])]) {
    const structure = z
      .object({
        rules: ConfigObjectSchema.optional(),
        options: ConfigObjectSchema.optional(),
        files: z.array(z.string()).optional(),
        ignorePatterns: z.array(z.string()).optional(),
      })
      .safeParse(section);

    const plugins = z
      .array(z.union([z.string(), ConfigObjectSchema]))
      .safeParse(section.jsPlugins ?? []);

    result.uncertain ||= !structure.success || !plugins.success;

    for (const plugin of plugins.data ?? []) {
      const specifier =
        z.string().safeParse(plugin).data ??
        z.string().safeParse(configObject(plugin).specifier).data;

      if (specifier === undefined) {
        result.uncertain = true;
      } else if (
        /^\.\.?\//.test(specifier) &&
        (/(?:^|[/_-])anti-slop(?:[/_.-]|$)/.test(specifier) ||
          configObject(plugin).name === "anti-slop")
      ) {
        const local = resolvePath(parentPath(path), specifier);

        if (local && !local.split("/").includes("node_modules")) {
          result.legacy.push(path);
        } else {
          result.uncertain = true;
        }
      }
    }
  }

  const extensions = z.array(z.string()).safeParse(config.extends ?? []);

  if (!extensions.success) {
    return { ...result, uncertain: true };
  }

  const next = new Set([...visiting, path]);

  for (const extension of new Set(extensions.data)) {
    if (traversal.remaining <= 0) {
      result.uncertain = true;
      break;
    }

    const resolved = /^\.\.?\//.test(extension) ? resolvePath(parentPath(path), extension) : null;

    if (!resolved) {
      result.uncertain = true;
      continue;
    }

    if (
      /(?:^|\/)node_modules\/@aranlucas\/oxforge\/configs\/(?:base|recommended)\.json$/.test(
        resolved,
      )
    ) {
      result.preset = true;
      continue;
    }

    // Framework presets are additive, not a replacement for base/recommended.
    if (
      /(?:^|\/)node_modules\/@aranlucas\/oxforge\/configs\/(?:react|nextjs|react-perf|vitest|tailwind|shadcn|size-limits|type-aware)\.json$/.test(
        resolved,
      )
    ) {
      continue;
    }

    const child = inspectLintConfig(files, resolved, complete, next, traversal);
    result.preset ||= child.preset;
    result.uncertain ||= child.uncertain;
    result.missing ||= child.missing;
    result.legacy.push(...child.legacy);
    result.paths.push(...child.paths);
  }

  return { ...result, paths: [...new Set(result.paths)], legacy: [...new Set(result.legacy)] };
}
