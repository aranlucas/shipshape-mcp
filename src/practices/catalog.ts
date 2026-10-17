import type { PracticeOrigin, PracticeSummary } from "../api/contract";
import type { AppEnv } from "../env";
import { installationClient } from "../github/app";
import { octokitGet } from "../github/client";
import { z } from "zod";
import { bundledBuiltIns, type BuiltInSet } from "./built-in";
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
  /** Absent on catalog-repository practices that don't shadow a built-in. */
  origin?: PracticeOrigin;
  /** An override whose files are identical to the built-in it shadows. */
  matchesBuiltIn?: boolean;
}

export interface Catalog {
  repo: string;
  /** Version of the practice set; results recorded against another version are stale. */
  sha: string;
  practices: CatalogPractice[];
}

/** What the catalog repository contributes; stored in D1 as loaded. */
export interface CatalogLayer extends Catalog {
  /** Built-in practice ids the repository turns off with a `disabled` marker. */
  disabled: string[];
}

/** Built-in practices overlaid by the catalog repository. */
export interface EffectiveCatalog extends Catalog {
  /** Catalog repository commit the set was composed from. */
  commit: string;
  /** Built-in practices the catalog repository turns off. */
  disabled: CatalogPractice[];
}

function sameDefinition(left: CatalogPractice, right: CatalogPractice): boolean {
  const files = (practice: CatalogPractice) =>
    JSON.stringify(Object.entries(practice.files).toSorted(([a], [b]) => a.localeCompare(b)));

  return (
    left.yaml === right.yaml &&
    left.instructions === right.instructions &&
    files(left) === files(right)
  );
}

/**
 * Built-ins first, then the catalog repository: a folder with the same id
 * overrides the built-in, a `disabled` marker turns it off, and any other
 * folder adds a custom practice. Without built-ins the version is the commit.
 */
export function composeCatalog(
  layer: CatalogLayer,
  builtIns: BuiltInSet = bundledBuiltIns(),
): EffectiveCatalog {
  const own = new Map(layer.practices.map((practice) => [practice.id, practice]));
  const turnedOff = new Set(layer.disabled);
  const builtInIds = new Set(builtIns.practices.map((practice) => practice.id));
  const practices: CatalogPractice[] = [];
  const disabled: CatalogPractice[] = [];

  for (const builtIn of builtIns.practices) {
    const override = own.get(builtIn.id);

    if (turnedOff.has(builtIn.id)) {
      disabled.push(builtIn);
    } else if (override) {
      practices.push({
        ...override,
        origin: "override",
        matchesBuiltIn: sameDefinition(override, builtIn),
      });
    } else {
      practices.push({ ...builtIn, origin: "built-in" });
    }
  }

  for (const practice of layer.practices) {
    if (!builtInIds.has(practice.id)) {
      practices.push({ ...practice, origin: "custom" });
    }
  }

  return {
    repo: layer.repo,
    sha: builtIns.practices.length > 0 ? `${layer.sha}+${builtIns.version}` : layer.sha,
    commit: layer.sha,
    practices: practices.toSorted((left, right) => left.id.localeCompare(right.id)),
    disabled,
  };
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
      origin: practice.origin ?? "custom",
      matchesBuiltIn: practice.matchesBuiltIn ?? false,
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
    origin: practice.origin ?? "custom",
    matchesBuiltIn: practice.matchesBuiltIn ?? false,
  };
}

export function practiceSummary(practice: CatalogPractice): PracticeSummary {
  return summaryForPractice(practice);
}

export async function loadCatalog(env: AppEnv): Promise<EffectiveCatalog> {
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
      /^practices\/[^/]+\/(?:practice\.yml|instructions\.md|disabled|files\/.*)$/u.test(entry.path),
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

  const folderOf = (pattern: RegExp) =>
    new Set(
      relevant.filter((entry) => pattern.test(entry.path)).map((entry) => entry.path.split("/")[1]),
    );

  // A `disabled` marker turns the folder's built-in off, whatever else the folder holds.
  const disabled = folderOf(/^practices\/[^/]+\/disabled$/u);

  const folders = [...folderOf(/^practices\/[^/]+\/practice\.yml$/u)].filter(
    (folder) => !disabled.has(folder),
  );

  const practices = folders.map((folder): CatalogPractice => {
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

  const layer: CatalogLayer = {
    repo: repoName,
    sha: commit.data.sha,
    practices,
    disabled: [...disabled].toSorted(),
  };

  await writeCatalog(env.DB, layer, new Date().toISOString());

  return composeCatalog(layer);
}

export async function readStoredCatalog(db: D1Database): Promise<EffectiveCatalog | null> {
  const row = await readCatalogRow(db);

  if (!row?.sha) {
    return null;
  }

  // SAFETY: the catalog row is written only by writeCatalog using CatalogPractice values.
  const practices = JSON.parse(row.practices_json) as CatalogPractice[];

  // SAFETY: disabled_json is written only by writeCatalog from a string array.
  const disabled = JSON.parse(row.disabled_json) as string[];

  // Validation is derived from the running schema, not the version that loaded the row.
  // Keep the original YAML and catalog SHA as evidence; never rewrite the catalog here.
  // Built-ins come from this deploy, so a release that changes them takes effect at once.
  return composeCatalog({
    repo: row.repo,
    sha: row.sha,
    practices: practices.map((practice) => ({
      ...practice,
      parsed: parsePractice(practice.yaml, practice.folder),
    })),
    disabled,
  });
}
