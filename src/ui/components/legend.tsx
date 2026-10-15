import { STATE_WORDS, type CellState } from "../format";
import { StateMark } from "./state-mark";

const ORDER: CellState[] = ["fail", "unknown", "pass", "not_applicable", "pending"];

export function Legend() {
  return (
    <ul class="legend" aria-label="Key">
      {ORDER.map((state) => (
        <li key={state}>
          <StateMark state={state} label="" />
          {STATE_WORDS[state]}
        </li>
      ))}
    </ul>
  );
}
