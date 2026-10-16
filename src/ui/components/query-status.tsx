interface QueryStatusProps {
  query: {
    isFetching: boolean;
    isPaused: boolean;
    failureCount: number;
    failureReason: Error | null;
  };
  label: string;
}

/** Kept separate from result content so retries never hide a successful response. */
export function QueryStatus({ query, label }: QueryStatusProps) {
  if (!query.isFetching && !query.isPaused) {
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
