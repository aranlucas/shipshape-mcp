import type { z, ZodType } from "zod";
import type { GitHubTreeSchema } from "./schemas";
import type { StoredRepository } from "../practices/store";

const CACHE_VERSION = 1;

const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

const MAX_CACHE_BYTES = 512 * 1024;

type SnapshotCacheValue = string | z.infer<typeof GitHubTreeSchema>;

interface CacheRow {
  payload_json: string;
}

/** Shared immutable inputs only; mutable GitHub endpoints are never stored here. */
export class GitHubSnapshotCache {
  constructor(
    private readonly db: D1Database,
    private readonly repo: StoredRepository,
    private readonly headSha: string,
    private readonly bypass = false,
  ) {}

  async get<T>(resource: string, schema: ZodType<T>): Promise<T | undefined> {
    if (this.bypass) {
      return undefined;
    }

    try {
      const row = await this.db
        .prepare(
          `SELECT payload_json FROM github_snapshot_cache
         WHERE installation_id = ? AND repo_full_name = ? AND head_sha = ?
           AND resource = ? AND expires_at > ?`,
        )
        .bind(
          this.repo.installationId,
          this.repo.fullName,
          this.headSha,
          `${CACHE_VERSION}:${resource}`,
          Math.floor(Date.now() / 1000),
        )
        .first<CacheRow>();

      return row ? schema.safeParse(JSON.parse(row.payload_json)).data : undefined;
    } catch {
      // An unavailable or malformed cache must fall back to a live GitHub read.
      return undefined;
    }
  }

  async put(resource: string, value: SnapshotCacheValue): Promise<void> {
    try {
      const payload = JSON.stringify(value);

      if (payload === undefined || new TextEncoder().encode(payload).byteLength > MAX_CACHE_BYTES) {
        return;
      }

      await this.db
        .prepare(
          `INSERT INTO github_snapshot_cache
           (installation_id, repo_full_name, head_sha, resource, payload_json, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id, repo_full_name, head_sha, resource) DO UPDATE SET
           payload_json = excluded.payload_json, expires_at = excluded.expires_at`,
        )
        .bind(
          this.repo.installationId,
          this.repo.fullName,
          this.headSha,
          `${CACHE_VERSION}:${resource}`,
          payload,
          Math.floor(Date.now() / 1000) + CACHE_TTL_SECONDS,
        )
        .run();
    } catch {
      // Persistence is optional; a successful GitHub read remains usable.
    }
  }
}

export async function pruneSnapshotCache(db: D1Database): Promise<void> {
  try {
    await db
      .prepare("DELETE FROM github_snapshot_cache WHERE expires_at <= ?")
      .bind(Math.floor(Date.now() / 1000))
      .run();
  } catch {
    // Cache maintenance must not prevent the scheduled sweep.
  }
}
