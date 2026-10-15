import type { RepoSummary } from "../api/contract";

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
