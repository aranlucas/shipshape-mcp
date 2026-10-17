/* oxlint-disable anti-slop/require-readable-spacing, eslint/no-await-in-loop */

import { z } from "zod";

import type { AppEnv } from "../env";
import { installationClient } from "./app";
import type { GitHubOctokit } from "./client";
import { getRepository } from "../practices/store";
import { RepoPath } from "../practices/schema";

const GitHubRefSchema = z.object({
  object: z.object({ sha: z.string(), type: z.string().optional() }),
});
const GitHubCommitSchema = z.object({ tree: z.object({ sha: z.string() }) });
const GitHubTreeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      type: z.string(),
      sha: z.string().nullable(),
    }),
  ),
});
const GitHubShaSchema = z.object({ sha: z.string() });

export class CatalogWriteRefusedError extends Error {
  constructor(owner: string, repo: string) {
    super(
      `Catalog writes are only allowed for the configured catalog repository (${owner}/${repo})`,
    );
    this.name = "CatalogWriteRefusedError";
  }
}

export interface CatalogChange {
  practiceId: string;
  delete?: boolean;
  /** With delete: leave a `disabled` marker so the built-in practice stays off. */
  disable?: boolean;
  yaml?: string;
  instructions?: string | null;
  files?: Array<{ path: string; content: string }>;
}

interface TreeEntry {
  path: string;
  mode?: string;
  type?: string;
  sha?: string | null;
}

type RepositoryParts = [string, string];
type RouteParameters = Record<string, string>;
type WriteParameters = Record<string, string | number | boolean | TreeEntry[]>;
type BlobContent = { path: string; content: string };

function splitRepository(repository: string): RepositoryParts | null {
  const match = repository.match(/^([^/]+)\/([^/]+)$/u);

  return match?.[1] && match[2] ? [match[1], match[2]] : null;
}

export function assertCatalogWrite(
  env: Pick<AppEnv, "CATALOG_REPO">,
  owner: string,
  repo: string,
): void {
  const configured = splitRepository(env.CATALOG_REPO);

  if (
    !configured ||
    configured[0].toLowerCase() !== owner.toLowerCase() ||
    configured[1].toLowerCase() !== repo.toLowerCase()
  ) {
    throw new CatalogWriteRefusedError(owner, repo);
  }
}

function validatePath(path: string): void {
  if (!RepoPath.safeParse(path).success) {
    throw new Error("Catalog file path is invalid");
  }
}

function routeParameters(owner: string, repo: string, extra: RouteParameters = {}) {
  return { owner, repo, ...extra };
}

async function writeRequest<T>(
  env: Pick<AppEnv, "CATALOG_REPO">,
  client: GitHubOctokit,
  owner: string,
  repo: string,
  route: `POST ${string}` | `PATCH ${string}`,
  parameters: WriteParameters,
  schema: z.ZodType<T>,
): Promise<T> {
  assertCatalogWrite(env, owner, repo);
  const response = await client.request(route, parameters);

  return schema.parse(response.data);
}

function canonicalFilePath(path: string): string {
  validatePath(path);

  return `files/${path}`;
}

function deletionEntry(entry: TreeEntry): TreeEntry {
  return {
    path: entry.path,
    mode: entry.mode,
    type: entry.type,
    sha: null,
  };
}

export async function commitCatalogChange(env: AppEnv, change: CatalogChange): Promise<string> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(change.practiceId) || change.practiceId.length > 64) {
    throw new Error("Practice id is invalid");
  }

  if (change.files !== undefined) {
    const seen = new Set<string>();

    for (const file of change.files) {
      const path = canonicalFilePath(file.path);

      if (seen.has(path)) {
        throw new Error("Catalog file paths must be unique");
      }

      seen.add(path);
    }
  }

  const repository = await getRepository(env.DB, env.CATALOG_REPO);

  if (!repository) {
    throw new Error("Catalog repository is not installed");
  }

  const client = await installationClient(env, repository.installationId, { retry: false });
  const owner = repository.owner;
  const repo = repository.name;
  assertCatalogWrite(env, owner, repo);
  const coordinates = routeParameters(owner, repo);
  const details = z
    .object({ default_branch: z.string().min(1) })
    .parse((await client.request("GET /repos/{owner}/{repo}", coordinates)).data);
  const branch = details.default_branch;
  const ref = await client.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
    ...coordinates,
    ref: `heads/${branch}`,
  });
  const base = GitHubRefSchema.parse(ref.data).object.sha;
  const commit = await client.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
    ...coordinates,
    commit_sha: base,
  });
  const baseTreeSha = GitHubCommitSchema.parse(commit.data).tree.sha;
  const tree = await client.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
    ...coordinates,
    tree_sha: baseTreeSha,
    recursive: "1",
  });
  const parsedTree = GitHubTreeSchema.parse(tree.data);

  if (parsedTree.truncated) {
    throw new Error("Catalog tree is truncated");
  }

  const baseEntries = parsedTree.tree;
  const prefix = `practices/${change.practiceId}/`;
  const current = baseEntries.filter((entry) => entry.path.startsWith(prefix));
  const currentBlobs = current.filter((entry) => entry.type === "blob");
  const entries: TreeEntry[] = [];
  const blobs: BlobContent[] = [];

  const marker = `${prefix}disabled`;

  if (change.delete) {
    // The marker blob below replaces any existing one; a tree can't list a path twice.
    entries.push(
      ...currentBlobs
        .filter((entry) => !(change.disable && entry.path === marker))
        .map(deletionEntry),
    );

    if (change.disable) {
      blobs.push({
        path: marker,
        content:
          "Turned off in Shipshape. Delete this folder to turn the built-in practice back on.\n",
      });
    }
  } else {
    // Saving a practice turns a disabled built-in back on with the saved definition.
    entries.push(...currentBlobs.filter((entry) => entry.path === marker).map(deletionEntry));

    if (change.yaml !== undefined) {
      blobs.push({ path: `${prefix}practice.yml`, content: change.yaml });
    }

    if (change.instructions !== undefined) {
      const path = `${prefix}instructions.md`;

      if (change.instructions === null) {
        entries.push({ path, mode: "100644", type: "blob", sha: null });
      } else {
        blobs.push({ path, content: change.instructions });
      }
    }

    if (change.files !== undefined) {
      const desiredFiles = new Set(
        change.files.map((file) => `${prefix}${canonicalFilePath(file.path)}`),
      );

      for (const entry of currentBlobs) {
        if (entry.path.startsWith(`${prefix}files/`) && !desiredFiles.has(entry.path)) {
          entries.push(deletionEntry(entry));
        }
      }

      for (const file of change.files) {
        const path = `${prefix}${canonicalFilePath(file.path)}`;
        blobs.push({ path, content: file.content });
      }
    }
  }

  for (const blob of blobs) {
    const created = await writeRequest(
      env,
      client,
      owner,
      repo,
      "POST /repos/{owner}/{repo}/git/blobs",
      { ...coordinates, content: blob.content, encoding: "utf-8" },
      GitHubShaSchema,
    );
    entries.push({ path: blob.path, mode: "100644", type: "blob", sha: created.sha });
  }

  const createdTree = await writeRequest(
    env,
    client,
    owner,
    repo,
    "POST /repos/{owner}/{repo}/git/trees",
    { ...coordinates, base_tree: baseTreeSha, tree: entries },
    GitHubShaSchema,
  );
  const message = change.disable
    ? `practice(${change.practiceId}): turn off built-in from dashboard`
    : change.delete
      ? `practice(${change.practiceId}): delete from dashboard`
      : `practice(${change.practiceId}): update from dashboard`;
  const createdCommit = await writeRequest(
    env,
    client,
    owner,
    repo,
    "POST /repos/{owner}/{repo}/git/commits",
    { ...coordinates, message, tree: createdTree.sha },
    GitHubShaSchema,
  );
  await writeRequest(
    env,
    client,
    owner,
    repo,
    "PATCH /repos/{owner}/{repo}/git/refs/{ref}",
    { ...coordinates, ref: `heads/${branch}`, sha: createdCommit.sha, force: false },
    GitHubRefSchema,
  );

  return createdCommit.sha;
}
