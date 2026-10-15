import type { OverviewResponse, PracticeSummary, RepoSummary } from "../api/contract";
import type { CellState } from "./format";

export function cellState(overview: OverviewResponse, repo: string, practice: string): CellState {
  const cell = overview.results[repo]?.[practice];

  return cell?.checkedAt ? cell.state : "pending";
}

export interface RepoTally {
  repo: RepoSummary;
  behind: number;
  unknown: number;
  following: number;
  applies: number;
  checked: boolean;
}

export function tallyRepo(overview: OverviewResponse, repo: RepoSummary): RepoTally {
  const tally: RepoTally = {
    repo,
    behind: 0,
    unknown: 0,
    following: 0,
    applies: 0,
    checked: overview.practices
      .filter((item) => item.valid)
      .every((item) => cellState(overview, repo.fullName, item.id) !== "pending"),
  };

  for (const practice of overview.practices.filter((item) => item.valid)) {
    const state = cellState(overview, repo.fullName, practice.id);

    if (state === "fail") {
      tally.behind += 1;
    } else if (state === "unknown") {
      tally.unknown += 1;
    } else if (state === "pass") {
      tally.following += 1;
    }

    if (state !== "not_applicable" && state !== "pending") {
      tally.applies += 1;
    }
  }

  return tally;
}

export interface PortfolioSummary {
  clear: number;
  applicable: number;
  behindRepos: number;
  unknownRepos: number;
  unchecked: number;
}

export function summarize(tallies: RepoTally[]): PortfolioSummary {
  const applicable = tallies.filter((tally) => tally.applies > 0);

  return {
    clear: applicable.filter((tally) => tally.checked && tally.behind === 0 && tally.unknown === 0)
      .length,
    applicable: applicable.length,
    behindRepos: applicable.filter((tally) => tally.behind > 0).length,
    unknownRepos: applicable.filter((tally) => tally.behind === 0 && tally.unknown > 0).length,
    unchecked: tallies.filter((tally) => !tally.checked).length,
  };
}

/** Behind first, then couldn't-check, then by name. */
export function compareTallies(a: RepoTally, b: RepoTally): number {
  return (
    b.behind - a.behind ||
    b.unknown - a.unknown ||
    Number(a.checked) - Number(b.checked) ||
    a.repo.name.localeCompare(b.repo.name)
  );
}

/** Invalid practices are reported once, not as a column of unknowns. */
interface PracticeGroupOptions {
  includeInvalid?: boolean;
}

export function practiceGroups(all: PracticeSummary[], options: PracticeGroupOptions = {}) {
  const practices = options.includeInvalid ? all : all.filter((item) => item.valid);

  return [
    {
      kind: "files" as const,
      label: "In the repository",
      practices: practices.filter((item) => item.kind === "files"),
    },
    {
      kind: "settings" as const,
      label: "GitHub settings",
      practices: practices.filter((item) => item.kind === "settings"),
    },
  ].filter((group) => group.practices.length > 0);
}

export function practiceCounts(overview: OverviewResponse, practiceId: string) {
  const counts: Record<CellState, number> = {
    fail: 0,
    unknown: 0,
    pass: 0,
    not_applicable: 0,
    pending: 0,
  };

  for (const repo of overview.repos) {
    counts[cellState(overview, repo.fullName, practiceId)] += 1;
  }

  return counts;
}
