/* oxlint-disable anti-slop/require-readable-spacing */

import type { AppEnv } from "./env";
import { syncInventory } from "./inventory/sync";
import { pruneSnapshotCache } from "./github/snapshot-cache";
import { bundledBuiltIns } from "./practices/built-in";
import { loadCatalog } from "./practices/catalog";
import { enqueueRepositories } from "./queue";
import { claimBuiltInVersion, listRepositories, type StoredRepository } from "./practices/store";

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
  // The sweep re-evaluates everything, so it also covers a built-in change.
  await claimBuiltInVersion(env.DB, bundledBuiltIns().version);
  await enqueueRepositories(env, repos, "sweep");
}
