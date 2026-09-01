import { z, type ZodType } from "zod";

import {
  GITHUB_API_ROOT,
  GITHUB_API_VERSION,
  GitHubBranchProtectionSchema,
  GitHubBranchSchema,
  GitHubCodeScanningAlertSchema,
  GitHubCommitSchema,
  GitHubDependabotAlertSchema,
  GitHubPullRequestSchema,
  GitHubRateLimitResponseSchema,
  GitHubRepositorySchema,
  GitHubSecretScanningAlertSchema,
  GitHubWorkflowRunsResponseSchema,
  type GitHubBranch,
  type GitHubBranchProtection,
  type GitHubCodeScanningAlert,
  type GitHubCommit,
  type GitHubDependabotAlert,
  type GitHubPullRequest,
  type GitHubRateLimitResponse,
  type GitHubRepository,
  type GitHubResponseMetadata,
  type GitHubSecretScanningAlert,
  type GitHubWorkflowRun,
  type RateLimitMetadata,
  type RepositoryCoordinates,
} from "./schemas";

export const DEFAULT_TIMEOUT_MS = 7_000;
export const MIN_TIMEOUT_MS = 6_000;
export const MAX_TIMEOUT_MS = 8_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
export const DEFAULT_MAX_PAGES = 5;
export const MAX_ALLOWED_PAGES = 20;
export const DEFAULT_MAX_CONCURRENCY = 4;
export const MAX_ALLOWED_CONCURRENCY = 8;
export const DEFAULT_PER_PAGE = 50;
export const MAX_PER_PAGE = 100;

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0020\u007f]/u;
const INVALID_REF_CHARACTER_PATTERN = /[~^:?*[\\]/u;

export interface GitHubClientOptions {
  /** A GitHub OAuth or fine-grained access token. It is never added to a URL. */
  token: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxPages?: number;
}

export interface GitHubGetOptions {
  query?: Record<string, string | number | boolean | undefined>;
  /** Override the cached ETag for this request. */
  etag?: string;
  signal?: AbortSignal;
  /** Set false to avoid using or updating the in-memory ETag cache. */
  cache?: boolean;
}

export interface GitHubPaginationOptions extends GitHubGetOptions {
  maxPages?: number;
  perPage?: number;
}

export interface GitHubResponse<T> {
  data: T;
  metadata: GitHubResponseMetadata;
}

export interface GitHubListOptions extends GitHubPaginationOptions {
  ref?: string;
  since?: string;
  until?: string;
  state?: "open" | "closed" | "all";
}

export class GitHubClientError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class GitHubInputError extends GitHubClientError {
  constructor(message: string) {
    super(message, "invalid_input");
  }
}

export class PrivateRepositoryError extends GitHubClientError {
  readonly repository: RepositoryCoordinates;

  constructor(repository: RepositoryCoordinates) {
    super(
      `Private repositories are outside the read-only portfolio scope: ${repository.owner}/${repository.repo}`,
      "private_repository",
    );
    this.repository = repository;
  }
}

export class GitHubTimeoutError extends GitHubClientError {
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(`GitHub request timed out after ${timeoutMs}ms: ${url}`, "timeout");
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

export class GitHubResponseTooLargeError extends GitHubClientError {
  readonly url: string;
  readonly limitBytes: number;

  constructor(url: string, limitBytes: number) {
    super(
      `GitHub response exceeded the ${limitBytes}-byte safety cap: ${url}`,
      "response_too_large",
    );
    this.url = url;
    this.limitBytes = limitBytes;
  }
}

export class GitHubPayloadError extends GitHubClientError {
  readonly url: string;

  constructor(url: string, message: string) {
    super(
      `GitHub returned an invalid payload for ${url}: ${message}`,
      "invalid_payload",
    );
    this.url = url;
  }
}

export class GitHubNotModifiedError extends GitHubClientError {
  readonly url: string;

  constructor(url: string) {
    super(
      `GitHub returned 304 without a cached representation: ${url}`,
      "not_modified_without_cache",
    );
    this.url = url;
  }
}

export class GitHubApiError extends GitHubClientError {
  readonly status: number;
  readonly url: string;
  readonly metadata: GitHubResponseMetadata;

  constructor(
    message: string,
    status: number,
    url: string,
    metadata: GitHubResponseMetadata,
  ) {
    super(message, `github_http_${status}`);
    this.status = status;
    this.url = url;
    this.metadata = metadata;
  }
}

type CachedResponse = {
  data: unknown;
  etag: string | null;
  metadata: GitHubResponseMetadata;
};

type RequestSignal = {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
};

/**
 * Validate a GitHub login. Keeping this strict prevents path traversal and
 * accidental requests to a different API route.
 */
export function validateOwner(owner: string): string {
  if (!OWNER_PATTERN.test(owner)) {
    throw new GitHubInputError(
      `Invalid GitHub owner: ${JSON.stringify(owner)}`,
    );
  }
  return owner;
}

export function validateRepository(repo: string): string {
  if (!REPOSITORY_PATTERN.test(repo) || repo === "." || repo === "..") {
    throw new GitHubInputError(
      `Invalid GitHub repository: ${JSON.stringify(repo)}`,
    );
  }
  return repo;
}

export function validateRef(ref: string): string {
  if (
    ref.length === 0 ||
    ref.length > 255 ||
    CONTROL_CHARACTER_PATTERN.test(ref) ||
    INVALID_REF_CHARACTER_PATTERN.test(ref) ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.startsWith(".") ||
    ref.endsWith(".") ||
    ref.endsWith(".lock") ||
    ref.includes("//")
  ) {
    throw new GitHubInputError(`Invalid Git ref: ${JSON.stringify(ref)}`);
  }
  if (
    ref.split("/").some((part) => part.length === 0 || part.startsWith("."))
  ) {
    throw new GitHubInputError(`Invalid Git ref: ${JSON.stringify(ref)}`);
  }
  return ref;
}

export function validateRepositoryCoordinates(
  repository: RepositoryCoordinates,
): RepositoryCoordinates {
  if (!repository || typeof repository !== "object") {
    throw new GitHubInputError("A repository must contain an owner and repo");
  }
  return {
    owner: validateOwner(repository.owner),
    repo: validateRepository(repository.repo),
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new GitHubInputError(`${name} must be a positive integer`);
  }
  return value;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  positiveInteger(value, name);
  return Math.min(value, maximum);
}

function headerNumber(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (!value || !/^\d+(?:\.\d+)?$/u.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rateLimitMetadata(headers: Headers): RateLimitMetadata {
  return {
    limit: headerNumber(headers, "x-ratelimit-limit"),
    remaining: headerNumber(headers, "x-ratelimit-remaining"),
    used: headerNumber(headers, "x-ratelimit-used"),
    resetAt: headerNumber(headers, "x-ratelimit-reset"),
    retryAfterSeconds: headerNumber(headers, "retry-after"),
  };
}

function parseLinkHeader(value: string | null): {
  nextUrl: string | null;
  previousUrl: string | null;
} {
  let nextUrl: string | null = null;
  let previousUrl: string | null = null;
  if (!value) return { nextUrl, previousUrl };

  for (const part of value.split(",")) {
    const match = part.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"/u);
    if (!match) continue;
    if (match[2] === "next") nextUrl = match[1];
    if (match[2] === "prev") previousUrl = match[1];
  }
  return { nextUrl, previousUrl };
}

function withPageQuery(path: string, page: number, perPage: number): string {
  const url = new URL(path, GITHUB_API_ROOT);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(perPage));
  return `${url.pathname}${url.search}`;
}

async function readBodyWithinLimit(
  response: Response,
  limitBytes: number,
  url: string,
): Promise<string> {
  const contentLength = headerNumber(response.headers, "content-length");
  if (contentLength !== null && contentLength > limitBytes) {
    throw new GitHubResponseTooLargeError(url, limitBytes);
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limitBytes) {
      throw new GitHubResponseTooLargeError(url, limitBytes);
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytesRead += result.value.byteLength;
      if (bytesRead > limitBytes) {
        await reader.cancel();
        throw new GitHubResponseTooLargeError(url, limitBytes);
      }
      chunks.push(decoder.decode(result.value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return chunks.join("");
}

function parseJson<T>(text: string, schema: ZodType<T>, url: string): T {
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new GitHubPayloadError(url, "response was not valid JSON");
  }

  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new GitHubPayloadError(
      url,
      result.error.issues
        .slice(0, 3)
        .map((issue) => issue.message)
        .join("; "),
    );
  }
  return result.data;
}

function createRequestSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
): RequestSignal {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromExternal = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", abortFromExternal, { once: true });
  }
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      external?.removeEventListener("abort", abortFromExternal);
    },
  };
}

export class GitHubClient {
  readonly apiVersion = GITHUB_API_VERSION;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxPages: number;

  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly cache = new Map<string, CachedResponse>();

  constructor(options: GitHubClientOptions) {
    const token = options.token.trim();
    if (!token)
      throw new GitHubInputError("A non-empty GitHub Bearer token is required");

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < MIN_TIMEOUT_MS ||
      timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new GitHubInputError(
        `timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
      );
    }
    const maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    positiveInteger(maxResponseBytes, "maxResponseBytes");

    this.token = token;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.maxPages = boundedInteger(
      options.maxPages,
      DEFAULT_MAX_PAGES,
      MAX_ALLOWED_PAGES,
      "maxPages",
    );
    this.baseUrl = (options.baseUrl ?? GITHUB_API_ROOT).replace(/\/+$/u, "");
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * The sole public transport operation is GET. There are intentionally no
   * POST, PUT, PATCH, or DELETE methods in this client.
   */
  async get<T>(
    path: string,
    schema: ZodType<T>,
    options: GitHubGetOptions = {},
  ): Promise<GitHubResponse<T>> {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new GitHubInputError(
        "GitHub API paths must be relative paths beginning with a single slash",
      );
    }

    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const requestUrl = url.toString();
    const useCache = options.cache !== false;
    const cached = useCache ? this.cache.get(requestUrl) : undefined;
    const etag = options.etag ?? cached?.etag ?? undefined;
    const headers = new Headers({
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "shipshape-mcp-readiness-engine",
    });
    if (etag) headers.set("If-None-Match", etag);

    const requestSignal = createRequestSignal(options.signal, this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(requestUrl, {
        method: "GET",
        headers,
        signal: requestSignal.signal,
      });
    } catch (error) {
      requestSignal.cleanup();
      if (requestSignal.didTimeout())
        throw new GitHubTimeoutError(requestUrl, this.timeoutMs);
      throw error;
    }
    requestSignal.cleanup();

    const links = parseLinkHeader(response.headers.get("link"));
    const metadata: GitHubResponseMetadata = {
      url: requestUrl,
      status: response.status,
      etag: response.headers.get("etag"),
      notModified: response.status === 304,
      requestId: response.headers.get("x-github-request-id"),
      rateLimit: rateLimitMetadata(response.headers),
      nextUrl: links.nextUrl,
      previousUrl: links.previousUrl,
    };

    try {
      if (response.status === 304) {
        if (!cached) throw new GitHubNotModifiedError(requestUrl);
        return {
          data: cached.data as T,
          metadata: {
            ...cached.metadata,
            ...metadata,
            etag: cached.etag,
            nextUrl: metadata.nextUrl ?? cached.metadata.nextUrl,
            previousUrl: metadata.previousUrl ?? cached.metadata.previousUrl,
          },
        };
      }

      const body = await readBodyWithinLimit(
        response,
        this.maxResponseBytes,
        requestUrl,
      );
      if (!response.ok) {
        let message = `GitHub request failed with HTTP ${response.status}`;
        if (body) {
          try {
            const errorPayload = JSON.parse(body) as unknown;
            if (
              typeof errorPayload === "object" &&
              errorPayload !== null &&
              "message" in errorPayload
            ) {
              const apiMessage = (errorPayload as { message?: unknown })
                .message;
              if (typeof apiMessage === "string" && apiMessage.length <= 500)
                message = apiMessage;
            }
          } catch {
            // Preserve the typed HTTP error even when GitHub sends non-JSON text.
          }
        }
        throw new GitHubApiError(
          message,
          response.status,
          requestUrl,
          metadata,
        );
      }

      const data = parseJson(body, schema, requestUrl);
      if (useCache && metadata.etag) {
        this.cache.set(requestUrl, { data, etag: metadata.etag, metadata });
      }
      return { data, metadata };
    } catch (error) {
      if (requestSignal.didTimeout())
        throw new GitHubTimeoutError(requestUrl, this.timeoutMs);
      throw error;
    } finally {
      requestSignal.cleanup();
    }
  }

  async getPaginated<T>(
    path: string,
    itemSchema: ZodType<T>,
    options: GitHubPaginationOptions = {},
  ): Promise<GitHubResponse<T[]>> {
    const maxPages = boundedInteger(
      options.maxPages,
      this.maxPages,
      MAX_ALLOWED_PAGES,
      "maxPages",
    );
    const perPage = boundedInteger(
      options.perPage,
      DEFAULT_PER_PAGE,
      MAX_PER_PAGE,
      "perPage",
    );
    const pageQuery = { ...options.query };
    delete pageQuery.page;
    delete pageQuery.per_page;
    let nextPath = withPageQuery(path, 1, perPage);
    let page = 0;
    const data: T[] = [];
    let lastMetadata: GitHubResponseMetadata | null = null;

    while (nextPath && page < maxPages) {
      page += 1;
      const response = await this.get(nextPath, z.array(itemSchema), {
        ...options,
        query: page === 1 ? pageQuery : undefined,
      });
      data.push(...response.data);
      lastMetadata = response.metadata;
      nextPath = response.metadata.nextUrl
        ? this.pathFromLink(response.metadata.nextUrl)
        : "";
    }

    if (!lastMetadata) {
      throw new GitHubInputError("Pagination requires a valid API path");
    }
    return { data, metadata: lastMetadata };
  }

  async getRepository(
    repository: RepositoryCoordinates,
    options: GitHubGetOptions = {},
  ): Promise<GitHubResponse<GitHubRepository>> {
    const coordinates = validateRepositoryCoordinates(repository);
    const response = await this.get(
      this.repositoryPath(coordinates),
      GitHubRepositorySchema,
      options,
    );
    if (response.data.private) throw new PrivateRepositoryError(coordinates);
    return response;
  }

  async getBranch(
    repository: RepositoryCoordinates,
    ref: string,
    options: GitHubGetOptions = {},
  ): Promise<GitHubResponse<GitHubBranch>> {
    const coordinates = validateRepositoryCoordinates(repository);
    validateRef(ref);
    return this.get(
      `${this.repositoryPath(coordinates)}/branches/${encodeURIComponent(ref)}`,
      GitHubBranchSchema,
      options,
    );
  }

  async getBranchProtection(
    repository: RepositoryCoordinates,
    ref: string,
    options: GitHubGetOptions = {},
  ): Promise<GitHubResponse<GitHubBranchProtection>> {
    const coordinates = validateRepositoryCoordinates(repository);
    validateRef(ref);
    return this.get(
      `${this.repositoryPath(coordinates)}/branches/${encodeURIComponent(ref)}/protection`,
      GitHubBranchProtectionSchema,
      options,
    );
  }

  async listRepositories(
    owner: string,
    options: GitHubPaginationOptions = {},
  ): Promise<GitHubResponse<GitHubRepository[]>> {
    validateOwner(owner);
    const response = await this.getPaginated(
      `/users/${encodeURIComponent(owner)}/repos`,
      GitHubRepositorySchema,
      {
        ...options,
        query: {
          type: "owner",
          sort: "updated",
          direction: "desc",
          ...options.query,
        },
      },
    );
    for (const repository of response.data) {
      if (repository.private) {
        const [repositoryOwner, repositoryName] =
          repository.full_name.split("/");
        throw new PrivateRepositoryError({
          owner: repositoryOwner ?? owner,
          repo: repositoryName ?? repository.name,
        });
      }
    }
    return response;
  }

  async listCommits(
    repository: RepositoryCoordinates,
    options: GitHubListOptions = {},
  ): Promise<GitHubResponse<GitHubCommit[]>> {
    const coordinates = validateRepositoryCoordinates(repository);
    const query: Record<string, string | number | boolean | undefined> = {
      ...options.query,
    };
    if (options.ref) query.sha = validateRef(options.ref);
    if (options.since) query.since = options.since;
    if (options.until) query.until = options.until;
    return this.getPaginated(
      `${this.repositoryPath(coordinates)}/commits`,
      GitHubCommitSchema,
      {
        ...options,
        query,
      },
    );
  }

  async listPullRequests(
    repository: RepositoryCoordinates,
    options: GitHubListOptions = {},
  ): Promise<GitHubResponse<GitHubPullRequest[]>> {
    const coordinates = validateRepositoryCoordinates(repository);
    return this.getPaginated(
      `${this.repositoryPath(coordinates)}/pulls`,
      GitHubPullRequestSchema,
      {
        ...options,
        query: {
          state: options.state ?? "open",
          sort: "updated",
          direction: "desc",
          ...options.query,
        },
      },
    );
  }

  async listWorkflowRuns(
    repository: RepositoryCoordinates,
    options: GitHubListOptions = {},
  ): Promise<GitHubResponse<GitHubWorkflowRun[]>> {
    const coordinates = validateRepositoryCoordinates(repository);
    const query: Record<string, string | number | boolean | undefined> = {
      ...options.query,
    };
    if (options.ref) query.branch = validateRef(options.ref);
    delete query.page;
    delete query.per_page;
    const maxPages = boundedInteger(
      options.maxPages,
      this.maxPages,
      MAX_ALLOWED_PAGES,
      "maxPages",
    );
    const perPage = boundedInteger(
      options.perPage,
      DEFAULT_PER_PAGE,
      MAX_PER_PAGE,
      "perPage",
    );
    let nextPath = withPageQuery(
      `${this.repositoryPath(coordinates)}/actions/runs`,
      1,
      perPage,
    );
    let page = 0;
    const data: GitHubWorkflowRun[] = [];
    let metadata: GitHubResponseMetadata | null = null;
    while (nextPath && page < maxPages) {
      page += 1;
      const response = await this.get(
        nextPath,
        GitHubWorkflowRunsResponseSchema,
        {
          ...options,
          query: page === 1 ? query : undefined,
        },
      );
      data.push(...response.data.workflow_runs);
      metadata = response.metadata;
      nextPath = metadata.nextUrl ? this.pathFromLink(metadata.nextUrl) : "";
    }
    if (!metadata)
      throw new GitHubInputError(
        "Workflow pagination requires a valid API path",
      );
    return { data, metadata };
  }

  async listCodeScanningAlerts(
    repository: RepositoryCoordinates,
    options: GitHubPaginationOptions = {},
  ): Promise<GitHubResponse<GitHubCodeScanningAlert[]>> {
    const coordinates = validateRepositoryCoordinates(repository);
    return this.getPaginated(
      `${this.repositoryPath(coordinates)}/code-scanning/alerts`,
      GitHubCodeScanningAlertSchema,
      options,
    );
  }

  async listDependabotAlerts(
    repository: RepositoryCoordinates,
    options: GitHubPaginationOptions = {},
  ): Promise<GitHubResponse<GitHubDependabotAlert[]>> {
    const coordinates = validateRepositoryCoordinates(repository);
    return this.getPaginated(
      `${this.repositoryPath(coordinates)}/dependabot/alerts`,
      GitHubDependabotAlertSchema,
      options,
    );
  }

  async listSecretScanningAlerts(
    repository: RepositoryCoordinates,
    options: GitHubPaginationOptions = {},
  ): Promise<GitHubResponse<GitHubSecretScanningAlert[]>> {
    const coordinates = validateRepositoryCoordinates(repository);
    return this.getPaginated(
      `${this.repositoryPath(coordinates)}/secret-scanning/alerts`,
      GitHubSecretScanningAlertSchema,
      options,
    );
  }

  async getRateLimit(): Promise<GitHubResponse<GitHubRateLimitResponse>> {
    return this.get("/rate_limit", GitHubRateLimitResponseSchema);
  }

  private repositoryPath(repository: RepositoryCoordinates): string {
    return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  }

  private pathFromLink(link: string): string {
    const url = new URL(link);
    const base = new URL(this.baseUrl);
    if (url.origin !== base.origin)
      throw new GitHubInputError(
        "GitHub pagination link crossed the configured API origin",
      );
    return `${url.pathname}${url.search}`;
  }
}

/** Run asynchronous work with a small, explicit concurrency ceiling. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const concurrency = boundedInteger(
    limit,
    DEFAULT_MAX_CONCURRENCY,
    MAX_ALLOWED_CONCURRENCY,
    "concurrency",
  );
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const run = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => run()),
  );
  return results;
}
