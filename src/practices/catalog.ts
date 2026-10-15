import type { PracticeSummary } from "../api/contract";
import type { AppEnv } from "../env";
import { installationClient } from "../github/app";
import { octokitGet } from "../github/client";
import { z } from "zod";
import { parsePractice, type ParsedPractice } from "./schema";
import { getRepository, readCatalogRow, writeCatalog } from "./store";

const MAX_BLOBS = 200;

const MAX_BLOB_BYTES = 256 * 1024;

type BlobTuple = [string, string];

export class CatalogUnavailableError extends Error {
  constructor(repo: string) {
    super(`Install the Shipshape GitHub App on ${repo}`);
    this.name = "CatalogUnavailableError";
  }
}

export interface CatalogPractice {
  id: string;
  folder: string;
  yaml: string;
  instructions: string | null;
  files: Record<string, string>;
  parsed: ParsedPractice;
}

export interface Catalog {
  repo: string;
  sha: string;
  practices: CatalogPractice[];
}

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string | null;
  size?: number;
}

function decodeBlob(content: string): string {
  const binary = atob(content.replaceAll(/\s/gu, ""));
  const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);

  if (bytes.byteLength > MAX_BLOB_BYTES) {
    throw new Error(`Catalog blob exceeds ${MAX_BLOB_BYTES} bytes`);
  }

  return new TextDecoder().decode(bytes);
}

function summaryForPractice(practice: CatalogPractice): PracticeSummary {
  if (practice.parsed.ok) {
    return {
      id: practice.id,
      title: practice.parsed.practice.title,
      summary: practice.parsed.practice.summary,
      kind: practice.parsed.practice.kind,
      valid: true,
      error: null,
    };
  }

  const issue = practice.parsed.issues[0];

  return {
    id: practice.id,
    title: "",
    summary: "",
    kind: "files",
    valid: false,
    error: `${issue?.path ?? ""}: ${issue?.message ?? "invalid practice"}`,
  };
}

export function practiceSummary(practice: CatalogPractice): PracticeSummary {
  return summaryForPractice(practice);
}

export async function loadCatalog(env: AppEnv): Promise<Catalog> {
  const repoName = env.CATALOG_REPO;
  const repository = await getRepository(env.DB, repoName);

  if (!repository) {
    throw new CatalogUnavailableError(repoName);
  }

  const client = await installationClient(env, repository.installationId);
  const coordinates = { owner: repository.owner, repo: repository.name };

  const details = await octokitGet(
    client,
    "GET /repos/{owner}/{repo}",
    coordinates,
    // GitHub's repository response is intentionally narrowed at this boundary.
    z.object({ default_branch: z.string() }),
  );

  const commit = await octokitGet(
    client,
    "GET /repos/{owner}/{repo}/commits/{ref}",
    { ...coordinates, ref: details.data.default_branch },
    z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/iu) }),
  );

  const tree = await octokitGet(
    client,
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
    { ...coordinates, tree_sha: commit.data.sha, recursive: 1 },
    z.object({
      truncated: z.boolean(),
      tree: z.array(
        z.object({
          path: z.string(),
          mode: z.string(),
          type: z.string(),
          sha: z.string().nullable(),
          size: z.number().int().nonnegative().optional(),
        }),
      ),
    }),
  );

  if (tree.data.truncated) {
    throw new Error("Catalog tree is truncated");
  }

  const relevant = tree.data.tree.filter(
    (entry): entry is TreeEntry =>
      entry.type === "blob" &&
      /^practices\/[^/]+\/(?:practice\.yml|instructions\.md|files\/.*)$/u.test(entry.path),
  );

  if (relevant.length > MAX_BLOBS) {
    throw new Error(`Catalog exceeds ${MAX_BLOBS} blobs`);
  }

  const contents = new Map<string, string>();

  const blobs = await Promise.all(
    relevant.map(async (entry) => {
      if (entry.size !== undefined && entry.size > MAX_BLOB_BYTES) {
        throw new Error(`Catalog blob exceeds ${MAX_BLOB_BYTES} bytes`);
      }

      if (!entry.sha) {
        throw new Error(`Catalog blob ${entry.path} has no object id`);
      }

      const blob = await octokitGet(
        client,
        "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
        { ...coordinates, file_sha: entry.sha },
        z.object({
          content: z.string(),
          encoding: z.literal("base64"),
          size: z.number().int().nonnegative(),
        }),
      );

      if (blob.data.size > MAX_BLOB_BYTES) {
        throw new Error(`Catalog blob exceeds ${MAX_BLOB_BYTES} bytes`);
      }

      // SAFETY: this tuple is consumed as [path, content] immediately below.
      return [entry.path, decodeBlob(blob.data.content)] as BlobTuple;
    }),
  );

  for (const [path, content] of blobs) {
    contents.set(path, content);
  }

  const folders = new Set(
    relevant
      .filter((entry) => /^(?:practices\/[^/]+)\/practice\.yml$/u.test(entry.path))
      .map((entry) => entry.path.split("/")[1]),
  );

  const practices = [...folders].map((folder): CatalogPractice => {
    const prefix = `practices/${folder}/`;
    const yaml = contents.get(`${prefix}practice.yml`) ?? "";
    const files: Record<string, string> = {};

    for (const [path, content] of contents) {
      if (path.startsWith(`${prefix}files/`)) {
        files[path.slice(prefix.length)] = content;
      }
    }

    return {
      id: folder,
      folder,
      yaml,
      instructions: contents.get(`${prefix}instructions.md`) ?? null,
      files,
      parsed: parsePractice(yaml, folder),
    };
  });

  practices.sort((left, right) => left.id.localeCompare(right.id));
  const catalog = { repo: repoName, sha: commit.data.sha, practices };
  await writeCatalog(env.DB, catalog, new Date().toISOString());

  return catalog;
}

export async function readStoredCatalog(db: D1Database): Promise<Catalog | null> {
  const row = await readCatalogRow(db);

  if (!row?.sha) {
    return null;
  }

  // SAFETY: the catalog row is written only by writeCatalog using CatalogPractice values.
  const practices = JSON.parse(row.practices_json) as CatalogPractice[];

  return { repo: row.repo, sha: row.sha, practices };
}
