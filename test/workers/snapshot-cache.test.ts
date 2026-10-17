import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GitHubSnapshotCache, pruneSnapshotCache } from "@/github/snapshot-cache";
import { snapshotRepository } from "@test/helpers/snapshot";

const headSha = "b".repeat(40);

const file = "contents/package.json";

interface ExpiryRow {
  expires_at: number;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM github_snapshot_cache").run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("persistent GitHub snapshot cache", () => {
  it("shares data across instances while isolating commits, repositories, installations, and paths", async () => {
    await new GitHubSnapshotCache(env.DB, snapshotRepository, headSha).put(file, "manifest");

    const same = new GitHubSnapshotCache(env.DB, snapshotRepository, headSha);
    expect(await same.get(file, z.string())).toBe("manifest");
    expect(await same.get("contents/other.json", z.string())).toBeUndefined();
    expect(
      await new GitHubSnapshotCache(env.DB, snapshotRepository, "c".repeat(40)).get(
        file,
        z.string(),
      ),
    ).toBeUndefined();
    expect(
      await new GitHubSnapshotCache(
        env.DB,
        { ...snapshotRepository, fullName: "octo/other" },
        headSha,
      ).get(file, z.string()),
    ).toBeUndefined();
    expect(
      await new GitHubSnapshotCache(
        env.DB,
        { ...snapshotRepository, installationId: 43 },
        headSha,
      ).get(file, z.string()),
    ).toBeUndefined();
  });

  it("preserves empty files and bypasses cached reads for forced evaluations", async () => {
    const cache = new GitHubSnapshotCache(env.DB, snapshotRepository, headSha);
    await cache.put(file, "");

    expect(await cache.get(file, z.string())).toBe("");
    expect(
      await new GitHubSnapshotCache(env.DB, snapshotRepository, headSha, true).get(
        file,
        z.string(),
      ),
    ).toBeUndefined();
  });

  it("expires entries after seven days and prunes them without deleting fresh entries", async () => {
    const cache = new GitHubSnapshotCache(env.DB, snapshotRepository, headSha);
    await cache.put(file, "old");

    const row = await env.DB.prepare(
      "SELECT expires_at FROM github_snapshot_cache",
    ).first<ExpiryRow>();

    expect(row?.expires_at).toBeGreaterThanOrEqual(
      Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60 - 1,
    );
    await env.DB.prepare("UPDATE github_snapshot_cache SET expires_at = ?")
      .bind(Math.floor(Date.now() / 1000))
      .run();
    await cache.put("contents/fresh.txt", "fresh");

    expect(await cache.get(file, z.string())).toBeUndefined();
    await pruneSnapshotCache(env.DB);

    expect(await cache.get("contents/fresh.txt", z.string())).toBe("fresh");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM github_snapshot_cache").first(),
    ).toEqual({ count: 1 });
  });

  it.each(["not json", "42"])(
    "treats malformed or schema-incompatible data as a miss (%s)",
    async (payload) => {
      const cache = new GitHubSnapshotCache(env.DB, snapshotRepository, headSha);
      await cache.put(file, "manifest");
      await env.DB.prepare("UPDATE github_snapshot_cache SET payload_json = ?").bind(payload).run();

      expect(await cache.get(file, z.string())).toBeUndefined();
    },
  );

  it("skips payloads exceeding the cache byte budget", async () => {
    const cache = new GitHubSnapshotCache(env.DB, snapshotRepository, headSha);
    await cache.put(file, "😀".repeat(140_000));

    expect(await cache.get(file, z.string())).toBeUndefined();
  });

  it("treats storage failures as misses without failing successful reads", async () => {
    const cache = new GitHubSnapshotCache(env.DB, snapshotRepository, headSha);
    vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("Cache unavailable");
    });

    await expect(cache.put(file, "manifest")).resolves.toBeUndefined();
    await expect(cache.get(file, z.string())).resolves.toBeUndefined();
  });
});
