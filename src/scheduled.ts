import { logger } from "./logger";
import type { AppEnv } from "./env";
import { syncInventory } from "./inventory/sync";
import { pruneSnapshotCache } from "./github/snapshot-cache";
import { loadCatalog } from "./practices/catalog";
import { enqueueRepositories } from "./queue";
import { listRepositories, type StoredRepository } from "./practices/store";

async function inventoryForTrigger(env: AppEnv): Promise<StoredRepository[]> {
  try {
    return await syncInventory(env);
  } catch {
    logger.error("GitHub inventory refresh failed; using stored inventory");

    return listRepositories(env.DB);
  }
}

export async function handleScheduled(env: AppEnv): Promise<void> {
  await pruneSnapshotCache(env.DB);
  const repos = await inventoryForTrigger(env);
  await loadCatalog(env);
  await enqueueRepositories(env, repos, "sweep");
}
