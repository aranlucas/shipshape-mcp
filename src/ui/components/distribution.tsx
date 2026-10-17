import { STATE_WORDS, type CellState } from "../format";
import { StateMark } from "./state-mark";

const ORDER: CellState[] = ["fail", "unknown", "pass", "not_applicable", "pending"];

interface CountsProps {
  counts: Record<CellState, number>;
}

/** A proportional strip of repositories by state. */
export function Strip({ counts }: CountsProps) {
  const total = ORDER.reduce((sum, state) => sum + counts[state], 0) || 1;

  return (
    <span class="strip" aria-hidden="true">
      {ORDER.flatMap((state) =>
        counts[state] > 0
          ? [
              <span
                key={state}
                class={`strip-${state}`}
                style={{ flexGrow: counts[state] / total }}
              />,
            ]
          : [],
      )}
    </span>
  );
}

/** The strip with counts beside it. */
interface DistributionProps extends CountsProps {
  compact?: boolean;
}

export function Distribution({ counts, compact = false }: DistributionProps) {
  const shown = ORDER.filter((state) => counts[state] > 0);

  return (
    <div class={`distribution${compact ? " is-compact" : ""}`}>
      <Strip counts={counts} />
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
