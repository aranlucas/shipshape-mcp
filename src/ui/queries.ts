import { QueryClient, queryOptions, skipToken } from "@tanstack/react-query";
import type { OverviewResponse, RepoDetailResponse } from "../api/contract";
import { api, ApiError } from "./api";

export const POLL_MS = 3_000;

export const queryKeys = {
  overview: ["overview"],
  repos: ["repos"],
  practices: ["practices"],
} as const;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (_, error) =>
          !(error instanceof ApiError) ||
          error.status === 408 ||
          error.status === 429 ||
          error.status >= 500,
        retryDelay: (attempt) => Math.min(POLL_MS * 2 ** attempt, 30_000),
        staleTime: 30_000,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
}

export const overviewQuery = queryOptions({
  queryKey: queryKeys.overview,
  queryFn: ({ signal }) => api.overview(signal),
  refetchInterval: (query) =>
    query.state.data &&
    (query.state.data.sweep.pending > 0 ||
      Object.values(query.state.data.results).some((repo) =>
        Object.values(repo).some((cell) => cell.retrying),
      ))
      ? POLL_MS
      : false,
});

export function repoQuery(owner: string, name: string) {
  return queryOptions({
    queryKey: [...queryKeys.repos, owner, name],
    queryFn: ({ signal }) => api.repo(owner, name, signal),
  });
}

/** Poll only while details lag behind a known server snapshot. */
export function repoNeedsUpdate(detail: RepoDetailResponse, overview: OverviewResponse) {
  if (detail.catalog.sha !== overview.catalog.sha) {
    if (!overview.catalog.sha) {
      return false;
    }

    return (
      !detail.catalog.loadedAt ||
      !overview.catalog.loadedAt ||
      Date.parse(detail.catalog.loadedAt) <= Date.parse(overview.catalog.loadedAt)
    );
  }

  return Object.entries(overview.results[detail.repo.fullName] ?? {}).some(([id, expected]) => {
    const actual = detail.practices.find((entry) => entry.practice.id === id)?.result;

    if (Boolean(actual?.retrying) !== Boolean(expected.retrying)) {
      return true;
    }

    if (!expected.checkedAt) {
      return false;
    }

    return !actual?.checkedAt || Date.parse(actual.checkedAt) < Date.parse(expected.checkedAt);
  });
}

export function practiceQuery(id: string | null) {
  return queryOptions({
    queryKey: [...queryKeys.practices, id],
    queryFn: id === null ? skipToken : ({ signal }) => api.practice(id, signal),
    // This owner-only editor deliberately takes an initial copy for its draft.
    staleTime: Infinity,
  });
}
