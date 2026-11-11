import { describe, expect, it } from "vitest";

import type { CheckResult, PracticeState, PracticeSummary, RepoSummary } from "@/api/contract";
import { rankPriorities, type PriorityResult } from "@/practices/priorities";

const CHECKED_AT = "2026-10-15T12:00:00.000Z";

function practice(id: string, kind: "files" | "settings", valid = true): PracticeSummary {
  return {
    id,
    title: id,
    summary: `${id} summary`,
    kind,
    valid,
    error: valid ? null : "checks.0.type: Invalid option",
    origin: "custom",
    matchesBuiltIn: false,
  };
}

function repo(fullName: string, flags: Partial<RepoSummary> = {}): RepoSummary {
  const [owner = "owner", name = "repo"] = fullName.split("/");

  return {
    fullName,
    owner,
    name,
    private: false,
    archived: false,
    fork: false,
    language: "TypeScript",
    defaultBranch: "main",
    pushedAt: null,
    url: `https://github.com/${fullName}`,
    ...flags,
  };
}

function check(state: CheckResult["state"], label: string): CheckResult {
  return {
    type: "file-exists",
    label,
    state,
    path: null,
    expected: null,
    actual: null,
    detail: null,
  };
}

interface ResultOptions {
  checks?: CheckResult[];
  checkedAt?: string | null;
}

interface Finding {
  practice: PracticeSummary;
}

function result(
  repoName: string,
  practiceId: string,
  state: PracticeState,
  options: ResultOptions = {},
): PriorityResult {
  return {
    repo: repoName,
    practiceId,
    cell: {
      state,
      checkedAt: options.checkedAt === undefined ? CHECKED_AT : options.checkedAt,
      failing: state === "fail" ? 1 : 0,
      unknown: state === "unknown" ? 1 : 0,
    },
    checks: options.checks ?? [],
  };
}

const ids = (findings: Finding[]) => findings.map((finding) => finding.practice.id);

describe("maintenance priorities", () => {
  it("ranks practices by active repositories failing, then settings before files, then id", () => {
    const repos = [repo("o/a"), repo("o/b"), repo("o/c")];

    const ranked = rankPriorities({
      practices: [
        practice("zz-files", "files"),
        practice("one-repo", "files"),
        practice("squash", "settings"),
        practice("aa-files", "files"),
      ],
      repos,
      results: [
        result("o/a", "one-repo", "fail"),
        ...["o/a", "o/b"].flatMap((name) => [
          result(name, "zz-files", "fail"),
          result(name, "squash", "fail"),
          result(name, "aa-files", "fail"),
        ]),
      ],
    });

    expect(ids(ranked.actions)).toEqual(["squash", "aa-files", "zz-files", "one-repo"]);
    expect(ranked.actions[0]?.repos.map((item) => item.fullName)).toEqual(["o/a", "o/b"]);
  });

  it("leaves forks and archived repositories out of the ranking and reports them as excluded", () => {
    const ranked = rankPriorities({
      practices: [practice("husky", "files")],
      repos: [repo("o/active"), repo("o/fork", { fork: true }), repo("o/old", { archived: true })],
      results: [
        result("o/active", "husky", "pass"),
        result("o/fork", "husky", "fail"),
        result("o/old", "husky", "fail"),
      ],
    });

    expect(ranked.actions).toEqual([]);
    expect(ranked.excluded).toBe(2);
  });

  it("keeps unknown evidence separate from ranked failures", () => {
    const ranked = rankPriorities({
      practices: [practice("husky", "files")],
      repos: [repo("o/a"), repo("o/b")],
      results: [
        result("o/a", "husky", "fail", {
          checks: [check("pass", "Hook"), check("fail", "Script")],
        }),
        result("o/b", "husky", "unknown", {
          checks: [check("fail", "Hook"), check("unknown", "Script")],
        }),
      ],
    });

    expect(ranked.actions).toEqual([
      {
        practice: practice("husky", "files"),
        repos: [
          {
            fullName: "o/a",
            url: "https://github.com/o/a",
            checkedAt: CHECKED_AT,
            checks: [check("fail", "Script")],
          },
        ],
        evaluated: 1,
      },
    ]);
    expect(ranked.unknown).toEqual([
      {
        practice: practice("husky", "files"),
        repos: [
          {
            fullName: "o/b",
            url: "https://github.com/o/b",
            checkedAt: CHECKED_AT,
            checks: [check("unknown", "Script")],
          },
        ],
      },
    ]);
  });

  it("counts repositories without a check time or a current result as unchecked, not unknown", () => {
    const ranked = rankPriorities({
      practices: [practice("husky", "files"), practice("squash", "settings")],
      repos: [repo("o/never"), repo("o/pending"), repo("o/done")],
      results: [
        result("o/pending", "husky", "unknown", { checkedAt: null }),
        result("o/pending", "squash", "pass"),
        result("o/done", "husky", "pass"),
        result("o/done", "squash", "not_applicable"),
      ],
    });

    expect(ranked.unknown).toEqual([]);
    expect(ranked.unchecked).toBe(2);
  });

  it("counts only definite pass or fail results as evaluated", () => {
    const ranked = rankPriorities({
      practices: [practice("husky", "files")],
      repos: [repo("o/a"), repo("o/b"), repo("o/c"), repo("o/d")],
      results: [
        result("o/a", "husky", "fail"),
        result("o/b", "husky", "pass"),
        result("o/c", "husky", "not_applicable"),
        result("o/d", "husky", "unknown"),
      ],
    });

    expect(ranked.actions[0]?.evaluated).toBe(2);
  });

  it("ignores practices whose definitions are invalid", () => {
    const ranked = rankPriorities({
      practices: [practice("broken", "files", false)],
      repos: [repo("o/a")],
      results: [result("o/a", "broken", "fail")],
    });

    expect(ranked.actions).toEqual([]);
    expect(ranked.unchecked).toBe(0);
  });

  it("returns the top actions within the limit and reports how many remain", () => {
    const practices = ["a", "b", "c"].map((id) => practice(id, "files"));

    const ranked = rankPriorities({
      practices,
      repos: [repo("o/a")],
      results: practices.map((item) => result("o/a", item.id, "fail")),
      limit: 2,
    });

    expect(ids(ranked.actions)).toEqual(["a", "b"]);
    expect(ranked.remaining).toBe(1);
  });

  it("filters repositories by owner without regard to case", () => {
    const ranked = rankPriorities({
      practices: [practice("husky", "files")],
      repos: [repo("Aranlucas/a"), repo("other/b", { fork: true }), repo("other/c")],
      results: [result("Aranlucas/a", "husky", "fail"), result("other/c", "husky", "fail")],
      owner: "aranlucas",
    });

    expect(ranked.actions[0]?.repos.map((item) => item.fullName)).toEqual(["Aranlucas/a"]);
    expect(ranked.excluded).toBe(0);
  });
});
