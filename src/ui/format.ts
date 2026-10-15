import type { PracticeState } from "../api/contract";

/** "pending" means Shipshape has not evaluated this pair yet. */
export type CellState = PracticeState | "pending";

export const STATE_WORDS: Record<CellState, string> = {
  fail: "Behind",
  unknown: "Couldn't check",
  pass: "Following",
  not_applicable: "Doesn't apply",
  pending: "Not checked yet",
};

type TimeUnit = [unit: Intl.RelativeTimeFormatUnit, milliseconds: number];

const UNITS: TimeUnit[] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) {
    return "never";
  }

  const elapsed = new Date(iso).getTime() - now;

  for (const [unit, size] of UNITS) {
    if (Math.abs(elapsed) >= size) {
      return relative.format(Math.round(elapsed / size), unit);
    }
  }

  return "just now";
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
