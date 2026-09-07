import { z } from "zod";
import pLimit from "p-limit";
import {
  octokitGet,
  PrivateRepositoryError,
  GitHubInputError,
  type GitHubOctokit,
} from "../github/client";
import {
  GitHubRepositorySchema,
  RepositoryCoordinatesSchema,
  type RepositoryCoordinates,
} from "../github/schemas";
import { evaluateStandards, type StandardsSource } from "./evaluate";
import { parsePolicy, mergePolicy, type Policy } from "./policy";

const SHA = z.string().regex(/^[a-f0-9]{40}$/);
const TreeSchema = z.object({
  truncated: z.boolean(),
  tree: z
    .array(
      z.object({
        path: z.string().max(1024),
        type: z.string(),
        mode: z.string(),
        sha: SHA,
        size: z.number().int().nonnegative().optional(),
      }),
    )
    .max(100_000),
});
const BlobSchema = z.object({
  encoding: z.literal("base64"),
  content: z.string().max(180_000),
  size: z.number().int().nonnegative().max(128_000),
});
const selected = (path: string) =>
  /(^|\/)(package.json|go.mod|pyproject.toml|tsconfig.json)$/.test(path) ||
  /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
function decode(content: string) {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(atob(content.replace(/\s/g, "")), (char) =>
      char.charCodeAt(0),
    ),
  );
}
export async function collectStandards(
  client: GitHubOctokit,
  input: RepositoryCoordinates,
) {
  const coordinates = RepositoryCoordinatesSchema.parse(input);
  const repo = (
    await octokitGet(
      client,
      "GET /repos/{owner}/{repo}",
      coordinates,
      GitHubRepositorySchema,
    )
  ).data;
  if (repo.private) throw new PrivateRepositoryError(coordinates);
  const commit = (
    await octokitGet(
      client,
      "GET /repos/{owner}/{repo}/commits/{ref}",
      { ...coordinates, ref: repo.default_branch },
      z.object({ sha: SHA }),
    )
  ).data.sha;
  const source: StandardsSource = {
    repository: repo.full_name,
    commit,
    files: Object.create(null) as Record<string, string | null>,
    complete: false,
    policy: {
      baseline: "shipshape/recommended@1",
      packages: [],
      exceptions: [],
    },
    policyState: "unknown",
    collectedAt: new Date().toISOString(),
  };
  let entries: z.infer<typeof TreeSchema>["tree"] = [];
  try {
    const tree = (
      await octokitGet(
        client,
        "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
        { ...coordinates, tree_sha: commit, recursive: "1" },
        TreeSchema,
      )
    ).data;
    entries = tree.tree.filter(
      (entry) => entry.type === "blob" && entry.mode !== "120000",
    );
    source.complete = !tree.truncated;
    for (const entry of entries) source.files[entry.path] = null;
  } catch {
    return evaluateStandards(source);
  }
  const config = entries.find((entry) => entry.path === ".shipshape.yml");
  if (!config) source.policyState = source.complete ? "fail" : "unknown";
  else {
    let local: Policy | undefined;
    try {
      if ((config.size ?? 0) > 128_000) throw new Error("Too large");
      const blob = (
        await octokitGet(
          client,
          "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
          { ...coordinates, file_sha: config.sha },
          BlobSchema,
        )
      ).data;
      const text = decode(blob.content);
      source.files[config.path] = text;
      local = parsePolicy(text);
    } catch (error) {
      if (error instanceof GitHubInputError) throw error;
    }
    if (local) {
      source.policy = local;
      source.policyState = "pass";
      if (local.extends) {
        const shared = local.extends;
        try {
          const sharedRepo = (
            await octokitGet(
              client,
              "GET /repos/{owner}/{repo}",
              { owner: shared.owner, repo: shared.repo },
              GitHubRepositorySchema,
            )
          ).data;
          if (sharedRepo.private) throw new PrivateRepositoryError(shared);
          const sharedTree = (
            await octokitGet(
              client,
              "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
              {
                owner: shared.owner,
                repo: shared.repo,
                tree_sha: shared.ref,
                recursive: "1",
              },
              TreeSchema,
            )
          ).data;
          const entry = sharedTree.tree.find(
            (item) =>
              item.path === shared.path &&
              item.type === "blob" &&
              item.mode !== "120000",
          );
          if (!entry || (entry.size ?? 0) > 128_000)
            throw new Error("Shared policy unavailable");
          const file = (
            await octokitGet(
              client,
              "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
              { owner: shared.owner, repo: shared.repo, file_sha: entry.sha },
              BlobSchema,
            )
          ).data;
          source.policy = mergePolicy(parsePolicy(decode(file.content)), local);
          source.policyEvidence = `https://github.com/${shared.owner}/${shared.repo}/blob/${shared.ref}/${shared.path}`;
        } catch (error) {
          if (
            error instanceof PrivateRepositoryError ||
            error instanceof GitHubInputError
          )
            throw error;
          source.policyState = "unknown";
        }
      }
    }
  }
  const candidates = entries
    .filter((entry) => selected(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  // Bound decoded input to 2 MB and 80 requests, with at most four in flight.
  let bytes = 0;
  const reads = candidates
    .filter((entry) => {
      bytes += entry.size ?? 128_000;
      return bytes <= 2_000_000;
    })
    .slice(0, 80);
  const limit = pLimit(4);
  await Promise.all(
    reads.map((entry) =>
      limit(async () => {
        if ((entry.size ?? 0) > 128_000) return;
        try {
          const blob = (
            await octokitGet(
              client,
              "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
              { ...coordinates, file_sha: entry.sha },
              BlobSchema,
            )
          ).data;
          source.files[entry.path] = decode(blob.content);
        } catch {
          /* Unavailable files retain null contents and yield unknown. */
        }
      }),
    ),
  );
  return evaluateStandards(source);
}
