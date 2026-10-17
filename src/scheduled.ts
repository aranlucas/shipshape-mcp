/* oxlint-disable anti-slop/require-readable-spacing */

import type { AppEnv } from "./env";
import { syncInventory } from "./inventory/sync";
import { pruneSnapshotCache } from "./github/snapshot-cache";
import { loadCatalog } from "./practices/catalog";
import { enqueueRepositories } from "./queue";
import { listRepositories, type StoredRepository } from "./practices/store";

interface TriggerInventory {
  repos: StoredRepository[];
  refreshed: boolean;
}

export async function inventoryForTrigger(env: AppEnv): Promise<TriggerInventory> {
  try {
    return { repos: await syncInventory(env), refreshed: true };
  } catch {
    // oxlint-disable-next-line no-console
    console.error("GitHub inventory refresh failed; using stored inventory");
    return { repos: await listRepositories(env.DB), refreshed: false };
  }
}

export async function handleScheduled(env: AppEnv): Promise<void> {
  await pruneSnapshotCache(env.DB);
  const { repos } = await inventoryForTrigger(env);
  await loadCatalog(env);
  await enqueueRepositories(env, repos, "sweep");
}
