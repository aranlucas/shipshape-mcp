import type {
  ApiErrorResponse,
  CatalogWriteResponse,
  OverviewResponse,
  PracticeDetailResponse,
  RefreshRequest,
  RefreshResponse,
  RepoDetailResponse,
  SavePracticeRequest,
} from "../api/contract";
import * as z from "zod/mini";

type Issues = NonNullable<ApiErrorResponse["issues"]>;

type RequestBody = SavePracticeRequest | RefreshRequest;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: Issues = [],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const ErrorPayloadSchema = z.object({
  error: z.string(),
  issues: z.optional(z.array(z.object({ path: z.string(), message: z.string() }))),
});

function failure(status: number, payload: string): ApiError {
  let parsed: z.infer<typeof ErrorPayloadSchema> | undefined;

  try {
    parsed = ErrorPayloadSchema.safeParse(JSON.parse(payload)).data;
  } catch {
    parsed = undefined;
  }

  return new ApiError(
    parsed?.error ?? `The request failed with status ${status}.`,
    status,
    parsed?.issues ?? [],
  );
}

async function request<T>(
  path: string,
  method = "GET",
  body?: RequestBody,
  signal?: AbortSignal,
): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", signal };

  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }

  const response = await fetch(path, init);

  if (response.status === 401) {
    window.location.assign("/app");

    throw new ApiError("Your session ended. Sign in again to continue.", 401);
  }

  const payload = await response.text();

  if (!response.ok) {
    throw failure(response.status, payload);
  }

  // SAFETY: successful responses come from this Worker's /app/api routes, whose
  // handlers return the src/api/contract.ts types and are pinned by contract tests.
  return JSON.parse(payload) as T;
}

const segment = encodeURIComponent;

export const api = {
  overview: (signal?: AbortSignal) =>
    request<OverviewResponse>("/app/api/overview", "GET", undefined, signal),
  repo: (owner: string, name: string, signal?: AbortSignal) =>
    request<RepoDetailResponse>(
      `/app/api/repos/${segment(owner)}/${segment(name)}`,
      "GET",
      undefined,
      signal,
    ),
  practice: (id: string, signal?: AbortSignal) =>
    request<PracticeDetailResponse>(`/app/api/practices/${segment(id)}`, "GET", undefined, signal),
  savePractice: (id: string, body: SavePracticeRequest) =>
    request<CatalogWriteResponse>(`/app/api/practices/${segment(id)}`, "PUT", body),
  deletePractice: (id: string) =>
    request<CatalogWriteResponse>(`/app/api/practices/${segment(id)}`, "DELETE", {}),
  resetPractice: (id: string) =>
    request<CatalogWriteResponse>(`/app/api/practices/${segment(id)}/reset`, "POST", {}),
  refresh: (repo?: string) =>
    request<RefreshResponse>("/app/api/refresh", "POST", repo ? { repo } : {}),
};
