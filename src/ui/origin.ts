import type { PracticeOrigin, PracticeSummary } from "../api/contract";

export const ORIGIN_LABELS: Record<PracticeOrigin, string> = {
  "built-in": "Built in",
  override: "Edited",
  custom: "Yours",
};

/** Where a practice's definition comes from, and what saving or removing it does. */
export function originNote(practice: PracticeSummary, catalogRepo: string): string {
  switch (practice.origin) {
    case "built-in":
      return `Ships with Shipshape. Saving an edit stores your copy in ${catalogRepo}.`;
    case "override":
      return practice.matchesBuiltIn
        ? `${catalogRepo} has a copy identical to the built-in, so built-in updates don't reach it. Reset to follow the built-in.`
        : `Your copy in ${catalogRepo} replaces the built-in version.`;
    case "custom":
      return `Only in ${catalogRepo}.`;
  }
}
