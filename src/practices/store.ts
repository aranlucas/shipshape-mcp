import type { CellResult, CheckResult, RepoSummary } from "../api/contract";
import type { Catalog } from "./catalog";

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

  await db.batch(
    repos.map((repo) =>
      db
        .prepare(
          `INSERT INTO repositories
            (full_name, owner, name, installation_id, private, archived, fork, language,
             default_branch, pushed_at, html_url, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        .bind(
          repo.fullName,
          repo.owner,
          repo.name,
          repo.installationId,
          repo.private ? 1 : 0,
          repo.archived ? 1 : 0,
          repo.fork ? 1 : 0,
          repo.language,
          repo.defaultBranch,
          repo.pushedAt,
          repo.url,
          syncedAt,
        ),
    ),
  );
}

export async function deleteRepositoriesNotIn(
  db: D1Database,
  installationId: number,
  keep: string[],
): Promise<void> {
  const placeholders = keep.map(() => "?").join(", ");
  const keepClause = placeholders ? ` AND full_name NOT IN (${placeholders})` : "";
  const bindings: (string | number)[] = [installationId, ...keep];

  await db.batch([
    db
      .prepare(
        `DELETE FROM results
         WHERE repo_full_name IN (
           SELECT full_name FROM repositories
           WHERE installation_id = ?${keepClause}
         )`,
      )
      .bind(...bindings),
    db.prepare(`DELETE FROM repositories WHERE installation_id = ?${keepClause}`).bind(...bindings),
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
       FROM repositories WHERE full_name = ?`,
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
}

function resultFromRow(row: ResultRow): StoredResult {
  return {
    repo: row.repo_full_name,
    practiceId: row.practice_id,
    cell: {
      state: row.state,
      checkedAt: row.checked_at,
      failing: row.failing,
      unknown: row.unknown,
    },
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

  await db.batch(
    rows.map((row) =>
      db
        .prepare(
          `INSERT INTO results
             (repo_full_name, practice_id, state, failing, unknown, checks_json,
              head_sha, catalog_sha, checked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(repo_full_name, practice_id) DO UPDATE SET
             state = excluded.state,
             failing = excluded.failing,
             unknown = excluded.unknown,
             checks_json = excluded.checks_json,
             head_sha = excluded.head_sha,
             catalog_sha = excluded.catalog_sha,
             checked_at = excluded.checked_at`,
        )
        .bind(
          row.repo,
          row.practiceId,
          row.cell.state,
          row.cell.failing,
          row.cell.unknown,
          JSON.stringify(row.checks),
          row.headSha,
          row.catalogSha,
          row.cell.checkedAt,
        ),
    ),
  );
}

export async function readResults(db: D1Database, repo?: string): Promise<StoredResult[]> {
  const result = repo
    ? await db
        .prepare(
          `SELECT repo_full_name, practice_id, state, failing, unknown, checks_json,
                  head_sha, catalog_sha, checked_at
           FROM results WHERE repo_full_name = ? ORDER BY practice_id`,
        )
        .bind(repo)
        .all<ResultRow>()
    : await db
        .prepare(
          `SELECT repo_full_name, practice_id, state, failing, unknown, checks_json,
                  head_sha, catalog_sha, checked_at
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

  const checkedAt = null;
  const checks = JSON.stringify([unknownCheck(detail)]);

  await db.batch(
    catalog.practices.map((practice) =>
      db
        .prepare(
          `INSERT INTO results
             (repo_full_name, practice_id, state, failing, unknown, checks_json,
              head_sha, catalog_sha, checked_at)
           VALUES (?, ?, 'unknown', 0, 1, ?, NULL, ?, ?)
           ON CONFLICT(repo_full_name, practice_id) DO UPDATE SET
             state = 'unknown',
             failing = 0,
             unknown = 1,
             checks_json = excluded.checks_json,
             head_sha = NULL,
             catalog_sha = excluded.catalog_sha,
             checked_at = results.checked_at`,
        )
        .bind(repo, practice.id, checks, catalog.sha, checkedAt),
    ),
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

  const placeholders = practiceIds.map(() => "?").join(", ");
  await db
    .prepare(
      `DELETE FROM results
       WHERE repo_full_name = ? AND practice_id NOT IN (${placeholders})`,
    )
    .bind(repo, ...practiceIds)
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
