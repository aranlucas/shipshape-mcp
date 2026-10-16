import { QueryClient, queryOptions, skipToken } from "@tanstack/react-query";
import type { OverviewResponse } from "../api/contract";
import { api } from "./api";

const POLL_MS = 3_000;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
    },
  });
}

export const overviewQuery = queryOptions({
  queryKey: ["overview"],
  queryFn: ({ signal }) => api.overview(signal),
  refetchInterval: (query) => (query.state.data?.sweep.pending ? POLL_MS : false),
});

export function repoQuery(owner: string, name: string, overview: OverviewResponse) {
  const fullName = `${owner}/${name}`;

  return queryOptions({
    queryKey: [
      "repos",
      owner,
      name,
      {
        catalogSha: overview.catalog.sha,
        repo: overview.repos.find((item) => item.fullName === fullName),
        results: overview.results[fullName],
      },
    ],
    queryFn: ({ signal }) => api.repo(owner, name, signal),
    placeholderData: (previous, query) =>
      query?.queryKey[1] === owner && query.queryKey[2] === name ? previous : undefined,
  });
}

export function practiceQuery(id: string | null) {
  return queryOptions({
    queryKey: ["practices", id],
    queryFn: id === null ? skipToken : ({ signal }) => api.practice(id, signal),
  });
}
