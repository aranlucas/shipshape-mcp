import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import type { SavePracticeRequest } from "../api/contract";
import { api } from "./api";
import { practiceQuery, queryKeys } from "./queries";

interface SaveVariables {
  id: string;
  body: SavePracticeRequest;
}

function invalidateCatalog(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.overview }),
    client.invalidateQueries({ queryKey: queryKeys.repos }),
    client.invalidateQueries({ queryKey: queryKeys.practices }),
  ]);
}

export function refreshMutationOptions(client: QueryClient) {
  return mutationOptions({
    mutationFn: (repo?: string) => api.refresh(repo),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.overview }),
  });
}

export function savePracticeMutationOptions(client: QueryClient) {
  return mutationOptions({
    mutationFn: ({ id, body }: SaveVariables) => api.savePractice(id, body),
    onSuccess: () => invalidateCatalog(client),
  });
}

export function deletePracticeMutationOptions(client: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string) => api.deletePractice(id),
    onSuccess: async (_, id) => {
      // A deleted resource must not be refetched while its editor is still mounted.
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.overview }),
        client.invalidateQueries({ queryKey: queryKeys.repos }),
        client.invalidateQueries({
          queryKey: queryKeys.practices,
          predicate: (query) => query.queryKey[1] !== id,
        }),
      ]);
      client.removeQueries({ queryKey: practiceQuery(id).queryKey, exact: true });
    },
  });
}
