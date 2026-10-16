/* oxlint-disable eslint/no-await-in-loop */

import type { CellResult, CheckResult, RepoSummary } from "../api/contract";
import type { Catalog } from "./catalog";

const REPOSITORY_UPSERT_CHUNK_SIZE = 500;

const RESULT_WRITE_CHUNK_SIZE = 100;

const MAX_JSON_BINDING_BYTES = 512 * 1024;

function jsonChunks<T>(items: T[], maxItems: number): string[] {
  const chunks: string[] = [];
  let current: T[] = [];
  let currentBytes = 2;

  for (const item of items) {
    const itemJson = JSON.stringify(item);
    const itemBytes = new TextEncoder().encode(itemJson).byteLength;

    if (itemBytes + 2 > MAX_JSON_BINDING_BYTES) {
      throw new Error("D1 JSON binding item exceeds the maximum supported size");
    }

    if (
      current.length > 0 &&
      (current.length >= maxItems || currentBytes + itemBytes + 1 > MAX_JSON_BINDING_BYTES)
    ) {
      chunks.push(JSON.stringify(current));
      current = [];
      currentBytes = 2;
    }

    current.push(item);
    currentBytes += itemBytes + (current.length === 1 ? 0 : 1);
  }

  if (current.length > 0) {
    chunks.push(JSON.stringify(current));
  }

  return chunks;
}

export interface StoredRepository extends RepoSummary {
  installationId: number;
}

interface RepositoryRow {
  full_name: string;
  owner: string;
  name: string;
  installation_id: number;
  private: number;
  archived: number;
  fork: number;
  language: string | null;
  default_branch: string;
  pushed_at: string | null;
  html_url: string;
  synced_at: string;
}

function fromRow(row: RepositoryRow): StoredRepository {
  return {
    fullName: row.full_name,
    owner: row.owner,
    name: row.name,
    installationId: row.installation_id,
    private: row.private === 1,
    archived: row.archived === 1,
    fork: row.fork === 1,
    language: row.language,
    defaultBranch: row.default_branch,
    pushedAt: row.pushed_at,
    url: row.html_url,
  };
}

export async function upsertRepositories(
  db: D1Database,
  repos: StoredRepository[],
  syncedAt: string,
): Promise<void> {
  if (repos.length === 0) {
    return;
  }

  for (const chunk of jsonChunks(repos, REPOSITORY_UPSERT_CHUNK_SIZE)) {
    await db.batch([
      db
        .prepare(
          `WITH input AS (
             SELECT
               json_extract(value, '$.fullName') AS full_name,
               json_extract(value, '$.owner') AS owner,
               json_extract(value, '$.name') AS name,
               json_extract(value, '$.installationId') AS installation_id,
               json_extract(value, '$.private') AS private,
               json_extract(value, '$.archived') AS archived,
               json_extract(value, '$.fork') AS fork,
               json_extract(value, '$.language') AS language,
               json_extract(value, '$.defaultBranch') AS default_branch,
               json_extract(value, '$.pushedAt') AS pushed_at,
               json_extract(value, '$.url') AS html_url,
               ? AS synced_at
             FROM json_each(?)
           )
           INSERT INTO repositories
             (full_name, owner, name, installation_id, private, archived, fork, language,
              default_branch, pushed_at, html_url, synced_at)
           SELECT full_name, owner, name, installation_id, private, archived, fork, language,
                  default_branch, pushed_at, html_url, synced_at
           FROM input
           WHERE true
           ON CONFLICT(full_name) DO UPDATE SET
             owner = excluded.owner,
             name = excluded.name,
             installation_id = excluded.installation_id,
             private = excluded.private,
             archived = excluded.archived,
             fork = excluded.fork,
             language = excluded.language,
             default_branch = excluded.default_branch,
             pushed_at = excluded.pushed_at,
             html_url = excluded.html_url,
             synced_at = excluded.synced_at`,
        )
        .bind(syncedAt, chunk),
    ]);
  }
}

export async function deleteRepositoriesNotIn(
  db: D1Database,
  installationId: number,
  keep: string[],
): Promise<void> {
  const keepClause = " AND full_name NOT IN (SELECT value FROM json_each(?))";
  const keepJson = JSON.stringify(keep);

  await db.batch([
    db
      .prepare(
        `DELETE FROM results
         WHERE repo_full_name IN (
           SELECT full_name FROM repositories
           WHERE installation_id = ?${keepClause}
         )`,
      )
      .bind(installationId, keepJson),
    db
      .prepare(`DELETE FROM repositories WHERE installation_id = ?${keepClause}`)
      .bind(installationId, keepJson),
  ]);
}

export async function listRepositories(db: D1Database): Promise<StoredRepository[]> {
  const result = await db
    .prepare(
      `SELECT full_name, owner, name, installation_id, private, archived, fork, language,
              default_branch, pushed_at, html_url, synced_at
       FROM repositories ORDER BY full_name`,
    )
    .all<RepositoryRow>();

  return result.results.map(fromRow);
}

export async function getRepository(
  db: D1Database,
  fullName: string,
): Promise<StoredRepository | null> {
  const row = await db
    .prepare(
      `SELECT full_name, owner, name, installation_id, private, archived, fork, language,
              default_branch, pushed_at, html_url, synced_at
       FROM repositories WHERE full_name = ? COLLATE NOCASE`,
    )
    .bind(fullName)
    .first<RepositoryRow>();

  return row ? fromRow(row) : null;
}

export interface StoredCatalogRow {
  repo: string;
  sha: string | null;
  loaded_at: string | null;
  practices_json: string;
}

interface CatalogWrite {
  repo: string;
  sha: string;
  practices: unknown[];
}

export async function writeCatalog(
  db: D1Database,
  catalog: CatalogWrite,
  loadedAt: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO catalog (id, repo, sha, loaded_at, practices_json)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         repo = excluded.repo,
         sha = excluded.sha,
         loaded_at = excluded.loaded_at,
         practices_json = excluded.practices_json`,
    )
    .bind(catalog.repo, catalog.sha, loadedAt, JSON.stringify(catalog.practices))
    .run();
}

export function readCatalogRow(db: D1Database): Promise<StoredCatalogRow | null> {
  return db
    .prepare("SELECT repo, sha, loaded_at, practices_json FROM catalog WHERE id = 1")
    .first<StoredCatalogRow>();
}

export interface StoredResult {
  repo: string;
  practiceId: string;
  cell: CellResult;
  checks: CheckResult[];
  headSha: string | null;
  catalogSha: string | null;
}

interface ResultInput {
  repo: string;
  practiceId: string;
  state: CellResult["state"];
  failing: number;
  unknown: number;
  checks: string;
  headSha: string | null;
  catalogSha: string | null;
  checkedAt: string | null;
}

async function writeResultInputs(
  db: D1Database,
  inputs: ResultInput[],
  preserveCheckedAt: boolean,
): Promise<void> {
  const checkedAtUpdate = preserveCheckedAt ? "results.checked_at" : "excluded.checked_at";
  const statements: D1PreparedStatement[] = [];

  for (const chunk of jsonChunks(inputs, RESULT_WRITE_CHUNK_SIZE)) {
    statements.push(
      db
        .prepare(
          `WITH input AS (
             SELECT
               json_extract(value, '$.repo') AS repo_full_name,
               json_extract(value, '$.practiceId') AS practice_id,
               json_extract(value, '$.state') AS state,
               json_extract(value, '$.failing') AS failing,
               json_extract(value, '$.unknown') AS unknown,
               json_extract(value, '$.checks') AS checks_json,
               json_extract(value, '$.headSha') AS head_sha,
               json_extract(value, '$.catalogSha') AS catalog_sha,
               json_extract(value, '$.checkedAt') AS checked_at
             FROM json_each(?)
           )
           INSERT INTO results
             (repo_full_name, practice_id, state, failing, unknown, checks_json,
              head_sha, catalog_sha, checked_at)
           SELECT repo_full_name, practice_id, state, failing, unknown, checks_json,
                  head_sha, catalog_sha, checked_at
           FROM input
           WHERE true
           ON CONFLICT(repo_full_name, practice_id) DO UPDATE SET
             state = excluded.state,
             failing = excluded.failing,
             unknown = excluded.unknown,
             checks_json = excluded.checks_json,
             head_sha = excluded.head_sha,
             catalog_sha = excluded.catalog_sha,
             retrying = 0,
             checked_at = ${checkedAtUpdate}`,
        )
        .bind(chunk),
    );
  }

  if (statements.length > 0) {
    await db.batch(statements);
  }
}

interface ResultRow {
  repo_full_name: string;
  practice_id: string;
  state: CellResult["state"];
  failing: number;
  unknown: number;
  checks_json: string;
  head_sha: string | null;
  catalog_sha: string | null;
  checked_at: string | null;
  retrying: number;
}

function resultFromRow(row: ResultRow): StoredResult {
  const cell: CellResult = {
    state: row.state,
    checkedAt: row.checked_at,
    failing: row.failing,
    unknown: row.unknown,
  };

  if (row.retrying) {
    cell.retrying = true;
  }

  return {
    repo: row.repo_full_name,
    practiceId: row.practice_id,
    cell,
    // SAFETY: checks_json is written only by writeResults and markUnknown as a CheckResult array.
    checks: JSON.parse(row.checks_json) as CheckResult[],
    headSha: row.head_sha,
    catalogSha: row.catalog_sha,
  };
}

export async function writeResults(db: D1Database, rows: StoredResult[]): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  await writeResultInputs(
    db,
    rows.map((row) => ({
      repo: row.repo,
      practiceId: row.practiceId,
      state: row.cell.state,
      failing: row.cell.failing,
      unknown: row.cell.unknown,
      checks: JSON.stringify(row.checks),
      headSha: row.headSha,
      catalogSha: row.catalogSha,
      checkedAt: row.cell.checkedAt,
    })),
    false,
  );
}

export async function readResults(db: D1Database, repo?: string): Promise<StoredResult[]> {
  const result = repo
    ? await db
        .prepare(
          `SELECT repo_full_name, practice_id, state, failing, unknown, checks_json,
                  head_sha, catalog_sha, checked_at, retrying
           FROM results WHERE repo_full_name = ? ORDER BY practice_id`,
        )
        .bind(repo)
        .all<ResultRow>()
    : await db
        .prepare(
          `SELECT repo_full_name, practice_id, state, failing, unknown, checks_json,
                  head_sha, catalog_sha, checked_at, retrying
           FROM results ORDER BY repo_full_name, practice_id`,
        )
        .all<ResultRow>();

  return result.results.map(resultFromRow);
}

interface LastEvaluation {
  headSha: string | null;
  catalogSha: string | null;
}

export async function lastEvaluation(db: D1Database, repo: string): Promise<LastEvaluation | null> {
  const row = await db
    .prepare(
      `SELECT head_sha, catalog_sha
       FROM results WHERE repo_full_name = ?
       ORDER BY checked_at DESC LIMIT 1`,
    )
    .bind(repo)
    .first<Pick<ResultRow, "head_sha" | "catalog_sha">>();

  return row ? { headSha: row.head_sha, catalogSha: row.catalog_sha } : null;
}

const unknownCheck = (detail: string): CheckResult => ({
  type: "evaluation",
  label: "Evaluation availability",
  state: "unknown",
  path: null,
  expected: null,
  actual: null,
  detail,
});

export async function markUnknown(
  db: D1Database,
  repo: string,
  catalog: Catalog,
  detail: string,
): Promise<void> {
  if (catalog.practices.length === 0) {
    return;
  }

  const checks = JSON.stringify([unknownCheck(detail)]);

  await writeResultInputs(
    db,
    catalog.practices.map((practice) => ({
      repo,
      practiceId: practice.id,
      state: "unknown",
      failing: 0,
      unknown: 1,
      checks,
      headSha: null,
      catalogSha: catalog.sha,
      checkedAt: null,
    })),
    true,
  );
}

export async function deleteResultsNotIn(
  db: D1Database,
  repo: string,
  practiceIds: string[],
): Promise<void> {
  if (practiceIds.length === 0) {
    await db.prepare("DELETE FROM results WHERE repo_full_name = ?").bind(repo).run();

    return;
  }

  await db
    .prepare(
      `DELETE FROM results
       WHERE repo_full_name = ?
         AND practice_id NOT IN (SELECT value FROM json_each(?))`,
    )
    .bind(repo, JSON.stringify(practiceIds))
    .run();
}

export async function setResultsRetrying(
  db: D1Database,
  repo: string,
  practiceIds: string[],
  retrying: boolean,
): Promise<void> {
  await db
    .prepare(
      `UPDATE results SET retrying = ?
       WHERE repo_full_name = ? AND practice_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(retrying ? 1 : 0, repo, JSON.stringify(practiceIds))
    .run();
}

export async function incrementPending(db: D1Database, count: number): Promise<void> {
  if (count <= 0) {
    return;
  }

  await db.prepare("UPDATE sweep SET pending = pending + ? WHERE id = 1").bind(count).run();
}

export async function decrementPending(db: D1Database, count: number): Promise<void> {
  if (count <= 0) {
    return;
  }

  await db.prepare("UPDATE sweep SET pending = MAX(0, pending - ?) WHERE id = 1").bind(count).run();
}

export async function completePendingMessage(db: D1Database): Promise<void> {
  const completedAt = new Date().toISOString();

  await db
    .prepare(
      `UPDATE sweep
       SET pending = CASE WHEN pending > 0 THEN pending - 1 ELSE 0 END,
           last_completed_at = CASE
             WHEN pending > 0 AND pending - 1 = 0 THEN ?
             ELSE last_completed_at
           END
       WHERE id = 1`,
    )
    .bind(completedAt)
    .run();
}

export const incrementSweepPending = incrementPending;

export const completeSweepMessage = completePendingMessage;
