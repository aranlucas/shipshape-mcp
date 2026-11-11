/**
 * Dashboard API contract shared by the Worker (/app/api) and the UI.
 */

export type PracticeState = "pass" | "fail" | "unknown" | "not_applicable";

/**
 * built-in: ships with Shipshape (catalog-seed/). override: the catalog
 * repository's copy replaces the built-in. custom: only in the catalog repository.
 */
export type PracticeOrigin = "built-in" | "override" | "custom";

export interface PracticeSummary {
  id: string;
  title: string;
  summary: string;
  kind: "files" | "settings";
  valid: boolean;
  error: string | null; // validation error, if invalid
  origin: PracticeOrigin;
  matchesBuiltIn: boolean; // an override identical to its built-in, which stops it receiving updates
}

export interface RepoSummary {
  fullName: string; // "owner/name"
  owner: string;
  name: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  language: string | null;
  defaultBranch: string;
  pushedAt: string | null; // ISO
  url: string; // html_url
}

export interface CellResult {
  state: PracticeState;
  checkedAt: string | null; // ISO; null = never evaluated
  failing: number; // count of failing checks
  unknown: number;
  retrying?: boolean; // a temporary evaluation failure is queued for another attempt
}

export interface CheckResult {
  type: string;
  label: string;
  state: "pass" | "fail" | "unknown";
  path: string | null;
  expected: string | null;
  actual: string | null;
  detail: string | null;
}

export interface DisabledPractice {
  id: string;
  title: string;
  summary: string;
}

// GET /app/api/overview
export interface OverviewResponse {
  catalog: {
    repo: string;
    sha: string | null;
    loadedAt: string | null;
    disabled: DisabledPractice[]; // built-in practices the catalog repository turns off
  };
  practices: PracticeSummary[];
  repos: RepoSummary[];
  results: Record<string, Record<string, CellResult>>; // [fullName][practiceId]
  sweep: { lastCompletedAt: string | null; pending: number };
}

// GET /app/api/repos/:owner/:name
export interface RepoDetailResponse {
  catalog: Pick<OverviewResponse["catalog"], "sha" | "loadedAt">;
  repo: RepoSummary;
  headSha: string | null;
  practices: Array<{
    practice: PracticeSummary;
    result: CellResult;
    checks: CheckResult[];
    headSha: string | null; // immutable source of this practice evaluation
    catalogSha: string | null;
  }>;
}

// GET /app/api/practices/:id
export interface PracticeDetailResponse {
  practice: PracticeSummary;
  yaml: string; // raw practice.yml
  instructions: string | null; // raw instructions.md
  files: Array<{ path: string; content: string }>; // files/ tree
  counts: Record<PracticeState, number>;
}

/** One repository behind a priority, with the stored checks that put it there. */
export interface PriorityRepo {
  fullName: string;
  url: string;
  checkedAt: string; // ISO; when the evidence was recorded
  checks: CheckResult[]; // only checks in the finding's state (fail or unknown)
}

/** A practice that active repositories fail, grouped across the portfolio. */
export interface PriorityAction {
  practice: PracticeSummary;
  repos: PriorityRepo[]; // active repositories failing it, by name
  evaluated: number; // active repositories with a definite pass or fail result
}

/** A practice Shipshape couldn't check; never ranked against failures. */
export interface UnknownFinding {
  practice: PracticeSummary;
  repos: PriorityRepo[];
}

// GET /app/api/priorities?owner=&limit=
export interface PrioritiesResponse {
  catalog: Pick<OverviewResponse["catalog"], "sha" | "loadedAt">;
  // Most active repositories affected first; settings before file changes on a tie.
  actions: PriorityAction[];
  remaining: number; // ranked actions left out by the limit
  unknown: UnknownFinding[];
  unchecked: number; // active repositories not yet checked against every valid practice
  excluded: number; // forks and archived repositories left out of the ranking
}

// PUT /app/api/practices/:id   body: { yaml, instructions?, files? }
// → 200 { catalogSha } | 400 { error, issues?: Array<{path: string; message: string}> }
// DELETE /app/api/practices/:id → 200 { catalogSha }
//   custom practice: removes its folder. Built-in: replaces its folder with a `disabled` marker.
// POST /app/api/practices/:id/reset → 200 { catalogSha }
//   removes the catalog folder of a built-in, undoing an override or turning it back on.
// POST /app/api/refresh  body: { repo?: "owner/name" } → 202 { queued: number }

export interface SavePracticeRequest {
  yaml: string;
  instructions?: string | null;
  files?: Array<{ path: string; content: string }>;
}

export interface CatalogWriteResponse {
  catalogSha: string;
}

export interface ApiErrorResponse {
  error: string;
  issues?: Array<{ path: string; message: string }>;
}

export interface RefreshRequest {
  repo?: string;
}

export interface RefreshResponse {
  queued: number;
}
