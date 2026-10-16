/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/require-readable-spacing, typescript/switch-exhaustiveness-check */

import pLimit from "p-limit";
import { LINT_CONFIG_NAMES, joinPath, parseConfig, parentPath, resolvePath } from "./lint-config";
import { z } from "zod";
import { GitHubBranchProtectionSchema, GitHubBranchSchema } from "../github/schemas";
import { MAX_ALLOWED_CONCURRENCY, octokitGet, type GitHubOctokit } from "../github/client";
import { protectionState, type BranchProtectionFact } from "./protection";
import { LINT_STAGED_CONFIG_NAMES } from "./lint-staged";
import type { Check, Practice } from "./schema";
import type { StoredRepository } from "./store";

const SHA = z.string().regex(/^[a-f0-9]{40}$/u);
const ContentsFileSchema = z.object({
  type: z.literal("file"),
  encoding: z.literal("base64"),
  content: z.string(),
  size: z.number().int().nonnegative(),
});

const WORKFLOW_MARKER = ".github/workflows/*";
const MAX_FILE_READS = 64;
const MAX_FILE_BYTES = 512 * 1024;

const TreeSchema = z.object({
  truncated: z.boolean(),
  tree: z
    .array(
      z.object({
        path: z.string().max(1024),
        type: z.string(),
        mode: z.string(),
        sha: SHA,
        size: z.number().int().nonnegative().optional(),
      }),
    )
    .max(100_000),
});

function decode(content: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(atob(content.replaceAll(/\s/g, "")), (char) => char.codePointAt(0) ?? 0),
  );
}

export interface RepoSnapshot {
  repo: StoredRepository;
  headSha: string | null;
  tree: { paths: Set<string>; truncated: boolean } | null;
  treeError: string | null;
  files: Map<string, string | { error: string }>;
  settings: Record<string, unknown> | { error: string } | null;
  protection: Map<string, BranchProtectionFact>;
}

export interface PreloadedHead {
  sha: string | null;
  error?: string | null;
}

function checkFilePath(check: Check): string | null {
  switch (check.type) {
    case "dependabot-grouped":
      return check.path;
    case "file-matches":
    case "file-contains":
      return check.path;
    case "json-path":
    case "yaml-path":
    case "dependency":
      return check.file;
    default:
      return null;
  }
}

export function filesNeeded(practices: Practice[]): string[] {
  const paths = new Set<string>();

  for (const practice of practices) {
    for (const check of practice.checks) {
      if (check.type === "oxforge-format") {
        paths.add(joinPath(check.directory, "package.json"));
        paths.add(joinPath(check.directory, "oxfmt.config.ts"));
      }
      if (check.type === "husky-lint-staged") {
        paths.add("package.json");
        paths.add(".husky/pre-commit");
        for (const name of LINT_STAGED_CONFIG_NAMES) {
          paths.add(name);
        }
      }
      if (check.type === "oxforge") {
        paths.add(joinPath(check.directory, "package.json"));
        for (const name of LINT_CONFIG_NAMES) {
          paths.add(joinPath(check.directory, name));
        }
      }
      const path = checkFilePath(check);

      if (path) {
        paths.add(path);
      }

      if (check.type === "workflow") {
        paths.add(WORKFLOW_MARKER);
      }
    }
  }

  return [...paths];
}

function errorStatus(error: unknown): number | undefined {
  return z.object({ status: z.number() }).safeParse(error).data?.status;
}

function readError(error: unknown): string {
  const status = errorStatus(error);

  return status === undefined ? "File could not be read" : `GitHub returned HTTP ${status}`;
}

async function readProtection(
  client: GitHubOctokit,
  repo: StoredRepository,
  branch: string,
): Promise<BranchProtectionFact> {
  try {
    const branchResponse = await octokitGet(
      client,
      "GET /repos/{owner}/{repo}/branches/{branch}",
      { owner: repo.owner, repo: repo.name, branch },
      GitHubBranchSchema,
    );

    if (branchResponse.data.protected === false) {
      return { status: "unprotected" };
    }

    const protectionResponse = await octokitGet(
      client,
      "GET /repos/{owner}/{repo}/branches/{branch}/protection",
      { owner: repo.owner, repo: repo.name, branch },
      GitHubBranchProtectionSchema,
    );

    return { status: "protected", protection: protectionState(protectionResponse.data) };
  } catch (error) {
    const status = errorStatus(error);

    return {
      status: "unknown",
      reason:
        status === undefined
          ? "Branch protection could not be read."
          : `GitHub returned HTTP ${status} for branch protection.`,
    };
  }
}

function workflowPath(path: string): boolean {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path);
}

function contentPaths(treePaths: Set<string>, needed: string[]): string[] {
  const expanded = new Set<string>();

  for (const path of needed) {
    if (path === WORKFLOW_MARKER) {
      for (const treePath of treePaths) {
        if (workflowPath(treePath)) {
          expanded.add(treePath);
        }
      }
    } else if (treePaths.has(path)) {
      expanded.add(path);
    }
  }

  return [...expanded];
}

export async function takeSnapshot(
  client: GitHubOctokit,
  repo: StoredRepository,
  practices: Practice[],
  preloadedHead?: PreloadedHead,
): Promise<RepoSnapshot> {
  const needed = filesNeeded(practices);
  const needsSettings = practices.some((practice) =>
    practice.checks.some((check) => check.type === "setting"),
  );
  const branchNames = new Set(
    practices.flatMap((practice) =>
      practice.checks.flatMap((check) =>
        check.type === "branch-protection" ? [check.branch ?? repo.defaultBranch] : [],
      ),
    ),
  );

  let headSha: string | null = preloadedHead?.sha ?? null;
  let headError: string | null = preloadedHead?.error ?? null;

  if (preloadedHead === undefined) {
    try {
      const headResponse = await octokitGet(
        client,
        "GET /repos/{owner}/{repo}/commits/{ref}",
        { owner: repo.owner, repo: repo.name, ref: repo.defaultBranch },
        z.object({ sha: SHA }),
      );
      headSha = headResponse.data.sha;
    } catch (error) {
      const status = errorStatus(error);
      headError = status === 409 ? "Repository has no commits" : readError(error);
    }
  }

  let tree: RepoSnapshot["tree"] = null;
  let treeError: string | null = null;

  try {
    if (!headSha) {
      throw new Error(headError ?? "Repository head could not be read.");
    }

    const treeResponse = await octokitGet(
      client,
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
      { owner: repo.owner, repo: repo.name, tree_sha: headSha, recursive: "1" },
      TreeSchema,
    );
    tree = {
      paths: new Set(
        treeResponse.data.tree
          .filter((entry) => entry.type === "blob" && entry.mode !== "120000")
          .map((entry) => entry.path),
      ),
      truncated: treeResponse.data.truncated,
    };
  } catch (error) {
    const status = errorStatus(error);
    treeError = status === 409 ? "Repository has no commits" : (headError ?? readError(error));
  }

  const snapshot: RepoSnapshot = {
    repo,
    headSha,
    tree,
    treeError,
    files: new Map(),
    settings: null,
    protection: new Map(),
  };

  if (needsSettings) {
    try {
      const response = await octokitGet(
        client,
        "GET /repos/{owner}/{repo}",
        { owner: repo.owner, repo: repo.name },
        z.record(z.string(), z.unknown()),
      );
      snapshot.settings = response.data;
    } catch (error) {
      snapshot.settings = { error: readError(error) };
    }
  }

  if (branchNames.size) {
    const protections = await Promise.all(
      [...branchNames].map(
        async (branch) => [branch, await readProtection(client, repo, branch)] as const,
      ),
    );

    snapshot.protection = new Map(protections);
  }

  if (!tree) {
    return snapshot;
  }

  const paths = contentPaths(tree.paths, needed);
  const limit = pLimit(MAX_ALLOWED_CONCURRENCY);

  const followsLint = practices.some((practice) =>
    practice.checks.some((check) => check.type === "oxforge"),
  );
  let offset = 0;
  while (offset < paths.length) {
    const batch = paths.slice(offset);
    const start = offset;
    offset = paths.length;
    // Each wave discovers inherited configs; parallel reads stay inside the shared budget.
    // oxlint-disable-next-line eslint/no-await-in-loop
    await Promise.all(
      batch.map((path, batchIndex) =>
        limit(async () => {
          if (start + batchIndex >= MAX_FILE_READS) {
            snapshot.files.set(path, { error: "Read budget exceeded" });
            return;
          }

          try {
            const response = await octokitGet(
              client,
              "GET /repos/{owner}/{repo}/contents/{path}",
              { owner: repo.owner, repo: repo.name, path, ref: headSha ?? undefined },
              ContentsFileSchema,
            );

            if (response.data.size > MAX_FILE_BYTES) {
              snapshot.files.set(path, { error: "File larger than 512 KB" });
              return;
            }

            const content = decode(response.data.content);
            snapshot.files.set(path, content);
            if (followsLint && /\.jsonc?$/.test(path) && !path.endsWith("package.json")) {
              const extensions =
                z.array(z.string()).safeParse(parseConfig(content)?.extends).data ?? [];
              for (const extension of extensions) {
                const resolved = /^\.\.?\//.test(extension)
                  ? resolvePath(parentPath(path), extension)
                  : null;
                if (
                  resolved &&
                  !resolved.split("/").includes("node_modules") &&
                  tree.paths.has(resolved) &&
                  !paths.includes(resolved)
                ) {
                  paths.push(resolved);
                }
              }
            }
          } catch (error) {
            snapshot.files.set(path, { error: readError(error) });
          }
        }),
      ),
    );
  }

  return snapshot;
}
