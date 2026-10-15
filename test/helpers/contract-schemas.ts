/* oxlint-disable anti-slop/require-readable-spacing */

import { z } from "zod";

const practiceState = z.enum(["pass", "fail", "unknown", "not_applicable"]);

const practiceSummary = z
  .object({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    kind: z.enum(["files", "settings"]),
    valid: z.boolean(),
    error: z.string().nullable(),
  })
  .strict();

const repoSummary = z
  .object({
    fullName: z.string(),
    owner: z.string(),
    name: z.string(),
    private: z.boolean(),
    archived: z.boolean(),
    fork: z.boolean(),
    language: z.string().nullable(),
    defaultBranch: z.string(),
    pushedAt: z.string().nullable(),
    url: z.string(),
  })
  .strict();

const cellResult = z
  .object({
    state: practiceState,
    checkedAt: z.string().nullable(),
    failing: z.number(),
    unknown: z.number(),
  })
  .strict();

const checkResult = z
  .object({
    type: z.string(),
    label: z.string(),
    state: z.enum(["pass", "fail", "unknown"]),
    path: z.string().nullable(),
    expected: z.string().nullable(),
    actual: z.string().nullable(),
    detail: z.string().nullable(),
  })
  .strict();

export const OverviewResponseSchema = z
  .object({
    catalog: z
      .object({ repo: z.string(), sha: z.string().nullable(), loadedAt: z.string().nullable() })
      .strict(),
    practices: z.array(practiceSummary),
    repos: z.array(repoSummary),
    results: z.record(z.string(), z.record(z.string(), cellResult)),
    sweep: z.object({ lastCompletedAt: z.string().nullable(), pending: z.number() }).strict(),
  })
  .strict();

export const RepoDetailResponseSchema = z
  .object({
    repo: repoSummary,
    headSha: z.string().nullable(),
    practices: z.array(
      z
        .object({
          practice: practiceSummary,
          result: cellResult,
          checks: z.array(checkResult),
          headSha: z.string().nullable(),
          catalogSha: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const PracticeDetailResponseSchema = z
  .object({
    practice: practiceSummary,
    yaml: z.string(),
    instructions: z.string().nullable(),
    files: z.array(z.object({ path: z.string(), content: z.string() }).strict()),
    counts: z
      .object({
        pass: z.number(),
        fail: z.number(),
        unknown: z.number(),
        not_applicable: z.number(),
      })
      .strict(),
  })
  .strict();

export const ApiErrorResponseSchema = z
  .object({
    error: z.string(),
    issues: z.array(z.object({ path: z.string(), message: z.string() }).strict()).optional(),
  })
  .strict();

export const CatalogWriteResponseSchema = z.object({ catalogSha: z.string() }).strict();
export const RefreshResponseSchema = z.object({ queued: z.number() }).strict();
