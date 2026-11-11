import type {
  CellResult,
  CheckResult,
  PracticeSummary,
  PrioritiesResponse,
  PriorityAction,
  PriorityRepo,
  RepoSummary,
  UnknownFinding,
} from "../api/contract";

export interface PriorityResult {
  repo: string;
  practiceId: string;
  cell: CellResult;
  checks: CheckResult[];
}

export interface PriorityInput {
  practices: PracticeSummary[];
  repos: RepoSummary[];
  /** Results recorded against the current catalog only. */
  results: PriorityResult[];
  owner?: string;
  limit?: number;
}

type RankedFindings = Omit<PrioritiesResponse, "catalog">;

type Finding = Pick<PriorityAction, "practice" | "repos">;

// A settings change is one toggle; a file change needs a pull request in each repository.
const KIND_ORDER: Record<PracticeSummary["kind"], number> = { settings: 0, files: 1 };

function compareFindings(left: Finding, right: Finding): number {
  return (
    right.repos.length - left.repos.length ||
    KIND_ORDER[left.practice.kind] - KIND_ORDER[right.practice.kind] ||
    left.practice.id.localeCompare(right.practice.id)
  );
}

function priorityRepo(repo: RepoSummary, result: PriorityResult, checkedAt: string): PriorityRepo {
  const state = result.cell.state === "fail" ? "fail" : "unknown";

  return {
    fullName: repo.fullName,
    url: repo.url,
    checkedAt,
    checks: result.checks.filter((check) => check.state === state),
  };
}

/**
 * Groups current results into one ranked queue per practice. Unknown evidence
 * stays in its own list, and results without a check time count as unchecked,
 * matching the dashboard's pending state.
 */
export function rankPriorities(input: PriorityInput): RankedFindings {
  const ownerKey = input.owner?.toLowerCase();

  const scoped = input.repos.filter(
    (repo) => ownerKey === undefined || repo.owner.toLowerCase() === ownerKey,
  );

  const active = scoped
    .filter((repo) => !repo.fork && !repo.archived)
    .toSorted((left, right) => left.fullName.localeCompare(right.fullName));

  const practices = input.practices.filter((practice) => practice.valid);

  const cells = new Map<string, PriorityResult>();

  for (const result of input.results) {
    cells.set(`${result.repo}\n${result.practiceId}`, result);
  }

  const actions: PriorityAction[] = [];
  const unknown: UnknownFinding[] = [];
  const unchecked = new Set<string>();

  for (const practice of practices) {
    const failing: PriorityRepo[] = [];
    const unavailable: PriorityRepo[] = [];
    let evaluated = 0;

    for (const repo of active) {
      const result = cells.get(`${repo.fullName}\n${practice.id}`);
      const checkedAt = result?.cell.checkedAt;

      if (!result || !checkedAt) {
        unchecked.add(repo.fullName);
        continue;
      }

      if (result.cell.state === "fail") {
        evaluated += 1;
        failing.push(priorityRepo(repo, result, checkedAt));
      } else if (result.cell.state === "pass") {
        evaluated += 1;
      } else if (result.cell.state === "unknown") {
        unavailable.push(priorityRepo(repo, result, checkedAt));
      }
    }

    if (failing.length > 0) {
      actions.push({ practice, repos: failing, evaluated });
    }

    if (unavailable.length > 0) {
      unknown.push({ practice, repos: unavailable });
    }
  }

  const ranked = actions.toSorted(compareFindings);
  const shown = input.limit === undefined ? ranked : ranked.slice(0, input.limit);

  return {
    actions: shown,
    remaining: ranked.length - shown.length,
    unknown: unknown.toSorted(compareFindings),
    unchecked: unchecked.size,
    excluded: scoped.length - active.length,
  };
}
