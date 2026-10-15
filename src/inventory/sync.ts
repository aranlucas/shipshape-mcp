import { z } from "zod";

import type { AppEnv } from "../env";
import { appClient, installationClient } from "../github/app";
import { GitHubRepositorySchema } from "../github/schemas";
import { octokitPaginate } from "../github/client";
import {
  deleteRepositoriesNotIn,
  listRepositories,
  upsertRepositories,
  type StoredRepository,
} from "../practices/store";

const installationSchema = z.object({
  id: z.number().int().positive(),
  account: z.object({ login: z.string().min(1), type: z.string().min(1) }),
});

const inventoryPageSchema = z.object({
  total_count: z.number().int().nonnegative(),
  repositories: GitHubRepositorySchema.array(),
});

const repositoryItemSchema = inventoryPageSchema.shape.repositories.element;

const pagination = { maxPages: 20, perPage: 100 } as const;

interface InstallationRow {
  installation_id: number;
}

function toStoredRepository(
  repository: z.infer<typeof GitHubRepositorySchema>,
  installationId: number,
): StoredRepository {
  const separator = repository.full_name.indexOf("/");

  if (separator <= 0 || separator === repository.full_name.length - 1) {
    throw new Error(`GitHub repository has invalid full_name: ${repository.full_name}`);
  }

  return {
    fullName: repository.full_name,
    owner: repository.full_name.slice(0, separator),
    name: repository.name,
    private: repository.private,
    archived: repository.archived,
    fork: repository.fork,
    language: repository.language ?? null,
    defaultBranch: repository.default_branch,
    pushedAt: repository.pushed_at ?? null,
    url: repository.html_url,
    installationId,
  };
}

export async function syncInventory(env: AppEnv): Promise<StoredRepository[]> {
  const app = appClient(env);

  const installations = await octokitPaginate(
    await app,
    "GET /app/installations",
    {},
    installationSchema,
    pagination,
  );

  if (installations.metadata.nextUrl) {
    throw new Error("GitHub installation inventory was truncated");
  }

  const existingInstallations = await env.DB.prepare(
    "SELECT DISTINCT installation_id FROM repositories",
  ).all<InstallationRow>();

  const syncedAt = new Date().toISOString();

  await Promise.all(
    installations.data.map(async (installation) => {
      const client = await installationClient(env, installation.id);

      const repositories = await octokitPaginate(
        client,
        "GET /installation/repositories",
        {},
        repositoryItemSchema,
        pagination,
      );

      const stored = repositories.data.map((repository) =>
        toStoredRepository(repository, installation.id),
      );

      if (repositories.metadata.nextUrl) {
        throw new Error(
          `GitHub repository inventory was truncated for installation ${installation.id}`,
        );
      }

      if (
        repositories.totalCount === null ||
        repositories.data.length !== repositories.totalCount
      ) {
        throw new Error(
          `GitHub repository inventory count did not reconcile for installation ${installation.id}`,
        );
      }

      await upsertRepositories(env.DB, stored, syncedAt);
      await deleteRepositoriesNotIn(
        env.DB,
        installation.id,
        stored.map((repository) => repository.fullName),
      );
    }),
  );

  const currentInstallationIds = new Set(installations.data.map((installation) => installation.id));

  const removedInstallationIds = existingInstallations.results
    .map((row) => row.installation_id)
    .filter((installationId) => !currentInstallationIds.has(installationId));

  await Promise.all(
    removedInstallationIds.map((installationId) =>
      deleteRepositoriesNotIn(env.DB, installationId, []),
    ),
  );

  return listRepositories(env.DB);
}
