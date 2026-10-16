export interface QueryStatusProps {
  query: {
    isFetching: boolean;
    isPaused: boolean;
    failureCount: number;
    failureReason: Error | null;
  };
  label: string;
  /** Content is already on screen, so a routine refetch stays silent instead of shifting the layout. */
  background?: boolean;
}

/** Kept separate from result content so retries never hide a successful response. */
export function QueryStatus({ query, label, background = false }: QueryStatusProps) {
  if (!query.isFetching && !query.isPaused) {
    return null;
  }

  if (background && !query.isPaused && query.failureCount === 0) {
    return null;
  }

  return (
    <p class="loading" role="status">
      {query.isPaused
        ? "Waiting for a connection…"
        : query.failureCount > 0
          ? `${query.failureReason?.message ?? "A request failed."} Retrying automatically…`
          : label}
    </p>
  );
}
