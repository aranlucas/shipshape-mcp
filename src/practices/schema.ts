import { parseDocument } from "yaml";
import { z } from "zod";

type BranchProtectionKey = [string, ...string[]];

/** Branch-protection identifiers accepted by practice checks. */
export const BRANCH_PROTECTION_KEYS = [
  "enforceAdmins",
  "requiredConversationResolution",
  "requiredLinearHistory",
  "requiredSignatures",
  "allowForcePushes",
  "allowDeletions",
  "requireCodeOwnerReviews",
  "requireLastPushApproval",
  "dismissStaleReviews",
  "requiredApprovingReviews",
  "requiredStatusChecks",
] as const;

export const RepoPath = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (path) => !path.startsWith("/") && !path.split("/").includes(".."),
    "Use a repository-relative path without ..",
  );

const Scalar = z.union([z.string(), z.number(), z.boolean()]);

const JsonPathCheck = z
  .object({
    type: z.literal("json-path"),
    file: RepoPath,
    path: z.string().min(1).max(200),
    equals: Scalar.optional(),
    exists: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.equals === undefined) === (value.exists === undefined)) {
      context.addIssue({ code: "custom", message: "Provide exactly one of equals or exists" });
    }
  });

const YamlPathCheck = z
  .object({
    type: z.literal("yaml-path"),
    file: RepoPath,
    path: z.string().min(1).max(200),
    equals: Scalar.optional(),
    exists: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.equals === undefined) === (value.exists === undefined)) {
      context.addIssue({ code: "custom", message: "Provide exactly one of equals or exists" });
    }
  });

export const CheckSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("oxforge"),
      directory: RepoPath.default("."),
      minimumVersion: z
        .string()
        .regex(/^\d+\.\d+\.\d+$/u)
        .default("0.2.0"),
    })
    .strict(),
  z
    .object({
      type: z.literal("dependabot-grouped"),
      path: RepoPath.default(".github/dependabot.yml"),
    })
    .strict(),
  z
    .object({ type: z.literal("file-exists"), path: RepoPath, absent: z.boolean().default(false) })
    .strict(),
  z
    .object({
      type: z.literal("file-matches"),
      path: RepoPath,
      source: RepoPath.refine(
        (source) => source.startsWith("files/"),
        "source must point inside files/",
      ),
    })
    .strict(),
  z
    .object({ type: z.literal("file-contains"), path: RepoPath, text: z.string().min(1).max(500) })
    .strict(),
  JsonPathCheck,
  YamlPathCheck,
  z
    .object({
      type: z.literal("dependency"),
      file: RepoPath.default("package.json"),
      name: z.string().min(1).max(214),
      version: z.string().min(1).max(100).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("setting"),
      key: z.string().regex(/^[a-z_]+(\.[a-z_]+)*$/u),
      equals: Scalar,
    })
    .strict(),
  z
    .object({
      type: z.literal("branch-protection"),
      // SAFETY: the source list is non-empty and the compatibility alias is appended.
      key: z.enum([...BRANCH_PROTECTION_KEYS, "required_linear_history"] as BranchProtectionKey),
      equals: z.boolean(),
      branch: z.string().max(255).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("workflow"),
      check: z.enum(["least-privilege-token", "pinned-actions", "dependency-review"]),
    })
    .strict(),
]);

export type Check = z.infer<typeof CheckSchema>;

const AppliesToSchema = z
  .object({
    owners: z.array(z.string()).optional(),
    languages: z.array(z.string()).optional(),
    hasFiles: z.array(RepoPath).optional(),
    include: z.array(z.string()).default(["*"]),
    exclude: z.array(z.string()).default([]),
    archived: z.boolean().default(false),
    forks: z.boolean().default(false),
  })
  .strict();

export const PracticeSchema = z
  .object({
    version: z.literal(1),
    id: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
      .max(64),
    title: z.string().min(1).max(80),
    summary: z.string().min(1).max(200),
    kind: z.enum(["files", "settings"]),
    appliesTo: AppliesToSchema.default({
      include: ["*"],
      exclude: [],
      archived: false,
      forks: false,
    }),
    checks: z.array(CheckSchema).min(1).max(40),
  })
  .strict()
  .superRefine((practice, context) => {
    if (practice.kind === "settings") {
      for (const [index, check] of practice.checks.entries()) {
        if (check.type !== "setting" && check.type !== "branch-protection") {
          context.addIssue({
            code: "custom",
            path: ["checks", index],
            message: "settings practices may only use setting and branch-protection checks",
          });
        }
      }
    }
  });

export type Practice = z.infer<typeof PracticeSchema>;

export interface PracticeIssue {
  path: string;
  message: string;
}

export type ParsedPractice =
  | { ok: true; practice: Practice }
  | { ok: false; id: string | null; issues: PracticeIssue[] };

export function parsePractice(yamlText: string, expectedId?: string): ParsedPractice {
  let value: unknown;

  try {
    const document = parseDocument(yamlText, { uniqueKeys: true });

    if (document.errors.length > 0) {
      return {
        ok: false,
        id: null,
        issues: [
          { path: "", message: `Invalid YAML: ${document.errors[0]?.message ?? "parse error"}` },
        ],
      };
    }

    value = document.toJS({ maxAliasCount: 20 });
  } catch (error) {
    return {
      ok: false,
      id: null,
      issues: [
        {
          path: "",
          message: `Invalid YAML: ${error instanceof Error ? error.message : "parse error"}`,
        },
      ],
    };
  }

  const id = z.object({ id: z.string() }).safeParse(value).data?.id ?? null;
  const result = PracticeSchema.safeParse(value);

  if (!result.success) {
    const issues = result.error.issues.flatMap((issue) => {
      if (issue.code === "unrecognized_keys" && issue.path.length === 0) {
        return issue.keys.map((key) => ({ path: key, message: issue.message }));
      }

      return [{ path: issue.path.join("."), message: issue.message }];
    });

    return { ok: false, id, issues };
  }

  if (expectedId !== undefined && result.data.id !== expectedId) {
    return {
      ok: false,
      id,
      issues: [{ path: "id", message: `id must match its folder name "${expectedId}"` }],
    };
  }

  return {
    ok: true,
    practice: {
      ...result.data,
      checks: result.data.checks.map((check) =>
        check.type === "branch-protection" && check.key === "required_linear_history"
          ? { ...check, key: "requiredLinearHistory" }
          : check,
      ),
    },
  };
}

export function checkLabel(check: Check): string {
  switch (check.type) {
    case "oxforge":
      return `Shared Oxforge >= ${check.minimumVersion} in ${check.directory}`;
    case "dependabot-grouped":
      return "One grouped dependency-update pull request";
    case "file-exists":
      return `${check.path} ${check.absent ? "absent" : "exists"}`;
    case "file-matches":
      return `${check.path} matches ${check.source}`;
    case "file-contains":
      return `${check.path} contains ${JSON.stringify(check.text)}`;
    case "json-path":
    case "yaml-path":
      return `${check.file} ${check.path} = ${String(check.equals ?? check.exists)}`;
    case "dependency":
      return check.version === undefined
        ? `${check.name} declared`
        : `${check.name} declared at ${check.version}`;
    case "setting":
      return `${check.key} = ${String(check.equals)}`;
    case "branch-protection":
      return `${check.key} = ${String(check.equals)}`;
    case "workflow":
      return check.check === "pinned-actions" ? "Actions pinned to full commit SHAs" : check.check;
  }
}
