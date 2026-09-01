import type { Octokit } from "octokit";
import { z, type ZodType } from "zod";

import type { GitHubResponseMetadata } from "./schemas";

export const DEFAULT_MAX_PAGES = 5;
export const MAX_ALLOWED_PAGES = 20;
export const DEFAULT_PER_PAGE = 50;
export const MAX_PER_PAGE = 100;
export const MAX_ALLOWED_CONCURRENCY = 8;

export type GitHubOctokit = InstanceType<typeof Octokit>;

export class GitHubInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubInputError";
  }
}

export class PrivateRepositoryError extends Error {
  constructor(readonly repository: { owner: string; repo: string }) {
    super(
      `Private repositories are outside the read-only portfolio scope: ${repository.owner}/${repository.repo}`,
    );
    this.name = "PrivateRepositoryError";
  }
}

export class GitHubPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubPayloadError";
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result <= 0) {
    throw new GitHubInputError(`${name} must be a positive integer`);
  }
  return Math.min(result, maximum);
}

function links(value: string | undefined) {
  let nextUrl: string | null = null;
  let previousUrl: string | null = null;
  if (!value) return { nextUrl, previousUrl };
  for (const part of value.split(",")) {
    const match = part.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"/u);
    if (match?.[2] === "next") nextUrl = match[1] ?? null;
    if (match?.[2] === "prev") previousUrl = match[1] ?? null;
  }
  return { nextUrl, previousUrl };
}

const headerNumber = (value: string | undefined): number | null => {
  if (!value || !/^\d+(?:\.\d+)?$/u.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function responseMetadata(response: {
  url: string;
  status: number;
  headers: Record<string, string | number | undefined>;
}): GitHubResponseMetadata {
  const pagination = links(String(response.headers.link ?? "") || undefined);
  return {
    url: response.url,
    status: response.status,
    etag: response.headers.etag ? String(response.headers.etag) : null,
    notModified: response.status === 304,
    requestId: response.headers["x-github-request-id"]
      ? String(response.headers["x-github-request-id"])
      : null,
    rateLimit: {
      limit: headerNumber(String(response.headers["x-ratelimit-limit"] ?? "")),
      remaining: headerNumber(
        String(response.headers["x-ratelimit-remaining"] ?? ""),
      ),
      used: headerNumber(String(response.headers["x-ratelimit-used"] ?? "")),
      resetAt: headerNumber(
        String(response.headers["x-ratelimit-reset"] ?? ""),
      ),
      retryAfterSeconds: headerNumber(
        String(response.headers["retry-after"] ?? ""),
      ),
    },
    nextUrl: pagination.nextUrl,
    previousUrl: pagination.previousUrl,
  };
}

export function parseGitHubPayload<T>(schema: ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new GitHubPayloadError(
      parsed.error.issues
        .slice(0, 3)
        .map((issue) => issue.message)
        .join("; "),
    );
  }
  return parsed.data;
}

export async function octokitGet<T>(
  octokit: GitHubOctokit,
  route: `GET ${string}`,
  parameters: Record<string, unknown>,
  schema: ZodType<T>,
): Promise<{ data: T; metadata: GitHubResponseMetadata }> {
  const response = await octokit.request(route, parameters);
  return {
    data: parseGitHubPayload(schema, response.data),
    metadata: responseMetadata(response),
  };
}

export async function octokitPaginate<T>(
  octokit: GitHubOctokit,
  route: `GET ${string}`,
  parameters: Record<string, unknown>,
  itemSchema: ZodType<T>,
  options: { maxPages?: number; perPage?: number } = {},
): Promise<{ data: T[]; metadata: GitHubResponseMetadata }> {
  const maxPages = boundedInteger(
    options.maxPages,
    DEFAULT_MAX_PAGES,
    MAX_ALLOWED_PAGES,
    "maxPages",
  );
  const perPage = boundedInteger(
    options.perPage,
    DEFAULT_PER_PAGE,
    MAX_PER_PAGE,
    "perPage",
  );
  const data: T[] = [];
  let metadata: GitHubResponseMetadata | null = null;
  let page = 0;
  for await (const response of octokit.paginate.iterator(route, {
    ...parameters,
    per_page: perPage,
  })) {
    page += 1;
    const pageSchema = z
      .union([
        z.array(itemSchema),
        z.object({ workflow_runs: z.array(itemSchema) }),
      ])
      .transform((value) =>
        Array.isArray(value) ? value : value.workflow_runs,
      );
    data.push(...parseGitHubPayload(pageSchema, response.data));
    metadata = responseMetadata(response);
    if (page >= maxPages) break;
  }
  if (!metadata) throw new GitHubInputError("Pagination produced no request");
  return { data, metadata };
}
