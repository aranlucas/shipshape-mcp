import { STATE_WORDS, type CellState } from "../format";
import { StateMark } from "./state-mark";

const ORDER: CellState[] = ["fail", "unknown", "pass", "not_applicable", "pending"];

/** A proportional strip of repositories by state, with counts beside it. */
interface DistributionProps {
  counts: Record<CellState, number>;
  compact?: boolean;
}

export function Distribution({ counts, compact = false }: DistributionProps) {
  const total = ORDER.reduce((sum, state) => sum + counts[state], 0) || 1;
  const shown = ORDER.filter((state) => counts[state] > 0);

  return (
    <div class={`distribution${compact ? " is-compact" : ""}`}>
      <div class="strip" aria-hidden="true">
        {shown.map((state) => (
          <span key={state} class={`strip-${state}`} style={{ flexGrow: counts[state] / total }} />
        ))}
      </div>
      <ul class="tallies">
        {shown.map((state) => (
          <li key={state}>
            <StateMark state={state} label="" />
            <span class="tally-count">{counts[state]}</span> {STATE_WORDS[state].toLowerCase()}
          </li>
        ))}
      </ul>
    </div>
  );
}
