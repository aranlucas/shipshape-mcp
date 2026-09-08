import { parseDocument } from "yaml";
import { z } from "zod";
import { GitHubInputError } from "../github/client";
import { RepositoryCoordinatesSchema } from "../github/schemas";

export const RULE_NAMES = [
  "baseline",
  "format",
  "lint",
  "test",
  "typecheck",
  "lockfile",
  "strict",
  "ci-pr",
  "ci-gates",
  "updates",
] as const;
export const PackagePathSchema = z
  .string()
  .max(240)
  .refine(
    (path) =>
      path === "." ||
      (/^(?!\/)(?!.*(?:^|\/)\.\.?($|\/))[a-zA-Z0-9_.@/-]+$/.test(path) &&
        !path.endsWith("/")),
    "Use a repository-relative directory without traversal",
  );
export const FilePathSchema = PackagePathSchema.refine((path) => path !== ".");
export const CommandsSchema = z
  .object({
    format: z.string().trim().min(1).max(300).optional(),
    lint: z.string().trim().min(1).max(300).optional(),
    test: z.string().trim().min(1).max(300).optional(),
    typecheck: z.string().trim().min(1).max(300).optional(),
  })
  .strict();
export const PolicySchema = z
  .object({
    baseline: z.literal("shipshape/recommended@1"),
    extends: RepositoryCoordinatesSchema.extend({
      ref: z.string().regex(/^[a-f0-9]{40}$/),
      path: FilePathSchema,
    })
      .strict()
      .optional(),
    packages: z
      .array(
        z
          .object({
            path: PackagePathSchema,
            commands: CommandsSchema,
          })
          .strict(),
      )
      .max(20)
      .default([]),
    exceptions: z
      .array(
        z
          .object({
            rule: z
              .enum(RULE_NAMES)
              .refine(
                (rule) => rule !== "baseline",
                "Baseline adoption cannot be exempted",
              ),
            path: PackagePathSchema.default("."),
            reason: z.string().trim().min(10).max(300),
            expires: z.iso.date(),
          })
          .strict(),
      )
      .max(50)
      .default([]),
  })
  .strict()
  .superRefine((policy, context) => {
    if (
      new Set(policy.packages.map((pkg) => pkg.path)).size !==
      policy.packages.length
    )
      context.addIssue({ code: "custom", message: "Duplicate package paths" });
    const keys = policy.exceptions.map((item) => `${item.path}:${item.rule}`);
    if (new Set(keys).size !== keys.length)
      context.addIssue({ code: "custom", message: "Duplicate exceptions" });
  });
export type Policy = z.infer<typeof PolicySchema>;
export type Commands = z.infer<typeof CommandsSchema>;
export function parseYaml(text: string): unknown {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error("Invalid YAML");
  return doc.toJS({ maxAliasCount: 20 });
}
export function parsePolicy(text: string): Policy {
  try {
    return PolicySchema.parse(parseYaml(text));
  } catch {
    throw new GitHubInputError(
      "Invalid .shipshape.yml: use baseline shipshape/recommended@1, unique package paths, dated exceptions, and a full commit SHA for extends.",
    );
  }
}
export function mergePolicy(shared: Policy, local: Policy): Policy {
  if (shared.extends)
    throw new GitHubInputError("Shared policies cannot extend another policy.");
  const packages = new Map(shared.packages.map((pkg) => [pkg.path, pkg]));
  for (const pkg of local.packages)
    packages.set(pkg.path, {
      ...pkg,
      commands: { ...packages.get(pkg.path)?.commands, ...pkg.commands },
    });
  const exceptions = new Map(
    shared.exceptions.map((item) => [`${item.path}:${item.rule}`, item]),
  );
  for (const item of local.exceptions)
    exceptions.set(`${item.path}:${item.rule}`, item);
  return PolicySchema.parse({
    ...local,
    packages: [...packages.values()],
    exceptions: [...exceptions.values()],
  });
}
