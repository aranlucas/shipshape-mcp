/**
 * Dashboard API contract shared by the Worker (/app/api) and the UI.
 * Source of truth: docs/superpowers/specs/2026-10-15-personal-practices-design.md
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
