import { STATE_WORDS, type CellState } from "../format";

interface StateMarkProps {
  state: CellState;
  label?: string;
  loading?: boolean;
}

/**
 * Each state has its own shape as well as its own color, so the matrix still
 * reads in grayscale: a quiet dot for following, a split flag for behind,
 * a hatched box for couldn't check, a speck for doesn't apply.
 */
export function StateMark({ state, label, loading = false }: StateMarkProps) {
  if (loading) {
    return (
      <svg
        class="mark mark-loading"
        viewBox="0 0 16 16"
        width="16"
        height="16"
        role="img"
        aria-label={`${label ?? STATE_WORDS[state]} · Retrying…`}
      >
        <circle cx="8" cy="8" r="5" />
      </svg>
    );
  }

  return (
    <svg
      class={`mark mark-${state}`}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      role={label === "" ? undefined : "img"}
      aria-hidden={label === "" ? "true" : undefined}
      aria-label={label === "" ? undefined : (label ?? STATE_WORDS[state])}
    >
      {state === "pass" && <circle cx="8" cy="8" r="4.25" />}
      {state === "fail" && (
        <>
          <rect x="2.5" y="2.5" width="11" height="11" rx="1" class="mark-frame" />
          <path d="M2.5 13.5 L13.5 2.5 L13.5 12.5 Q13.5 13.5 12.5 13.5 Z" />
        </>
      )}
      {state === "unknown" && (
        <>
          <rect x="2.5" y="2.5" width="11" height="11" rx="1" class="mark-frame" />
          <path d="M5 13.5 L13.5 5 M2.5 10 L10 2.5" class="mark-hatch" />
        </>
      )}
      {state === "not_applicable" && <circle cx="8" cy="8" r="1.4" />}
      {state === "pending" && <circle cx="8" cy="8" r="4.25" class="mark-ring" />}
    </svg>
  );
}
