import { describe, expect, it } from "vitest";

import type {
  CellResult,
  OverviewResponse,
  PracticeState,
  PracticeSummary,
  RepoSummary,
} from "@/api/contract";
import { compareTallies, practiceGroups, summarize, tallyRepo } from "@/ui/model";

function practice(id: string, kind: "files" | "settings", valid = true): PracticeSummary {
  return {
    id,
    title: id,
    summary: `${id} summary`,
    kind,
    valid,
    error: valid ? null : "checks.0.type: Invalid option",
  };
}

function repo(name: string, flags: Partial<RepoSummary> = {}): RepoSummary {
  return {
    fullName: `aranlucas/${name}`,
    owner: "aranlucas",
    name,
    private: false,
    archived: false,
    fork: false,
    language: "TypeScript",
    defaultBranch: "main",
    pushedAt: null,
    url: `https://github.com/aranlucas/${name}`,
    ...flags,
  };
}

function cell(state: PracticeState): CellResult {
  return { state, checkedAt: "2026-10-15T12:00:00.000Z", failing: 0, unknown: 0 };
}

const PRACTICES = [
  practice("husky", "files"),
  practice("squash", "settings"),
  practice("broken", "files", false),
];

function overview(results: OverviewResponse["results"], repos: RepoSummary[]): OverviewResponse {
  return {
    catalog: { repo: "aranlucas/practices", sha: null, loadedAt: null },
    practices: PRACTICES,
    repos,
    results,
    sweep: { lastCompletedAt: null, pending: 0 },
  };
}

describe("dashboard model", () => {
  it("ignores invalid practices when tallying a repository", () => {
    const data = overview(
      { "aranlucas/alpha": { husky: cell("pass"), squash: cell("pass"), broken: cell("unknown") } },
      [repo("alpha")],
    );

    expect(tallyRepo(data, repo("alpha"))).toMatchObject({
      behind: 0,
      unknown: 0,
      following: 2,
      applies: 2,
      checked: true,
    });
  });

  it("summarizes clear, behind, couldn't-check, and unchecked repositories", () => {
    const repos = [repo("clear"), repo("behind"), repo("unsure"), repo("new"), repo("na")];

    const data = overview(
      {
        "aranlucas/clear": { husky: cell("pass"), squash: cell("pass") },
        "aranlucas/behind": { husky: cell("fail"), squash: cell("unknown") },
        "aranlucas/unsure": { husky: cell("pass"), squash: cell("unknown") },
        "aranlucas/na": { husky: cell("not_applicable"), squash: cell("not_applicable") },
      },
      repos,
    );

    expect(summarize(repos.map((item) => tallyRepo(data, item)))).toEqual({
      clear: 1,
      applicable: 3,
      behindRepos: 1,
      unknownRepos: 1,
      unchecked: 1,
    });
  });

  it("does not count partially checked repositories as following every practice", () => {
    const repos = [repo("partial")];
    const data = overview({ "aranlucas/partial": { husky: cell("pass") } }, repos);
    expect(summarize(repos.map((item) => tallyRepo(data, item)))).toMatchObject({
      clear: 0,
      unchecked: 1,
    });
  });

  it("keeps known failures visible when other practices are still pending", () => {
    const repos = [repo("partial")];
    const data = overview({ "aranlucas/partial": { husky: cell("fail") } }, repos);
    expect(summarize(repos.map((item) => tallyRepo(data, item)))).toMatchObject({
      clear: 0,
      behindRepos: 1,
      unchecked: 1,
    });
  });

  it("sorts the most-behind repositories first, then couldn't-check, then by name", () => {
    const repos = [repo("b-clear"), repo("a-clear"), repo("unsure"), repo("worst"), repo("bad")];

    const data = overview(
      {
        "aranlucas/b-clear": { husky: cell("pass"), squash: cell("pass") },
        "aranlucas/a-clear": { husky: cell("pass"), squash: cell("pass") },
        "aranlucas/unsure": { husky: cell("unknown"), squash: cell("pass") },
        "aranlucas/worst": { husky: cell("fail"), squash: cell("fail") },
        "aranlucas/bad": { husky: cell("fail"), squash: cell("pass") },
      },
      repos,
    );

    const order = repos
      .map((item) => tallyRepo(data, item))
      .toSorted(compareTallies)
      .map((tally) => tally.repo.name);

    expect(order).toEqual(["worst", "bad", "unsure", "a-clear", "b-clear"]);
  });

  it("groups valid practices by kind and keeps invalid ones only on request", () => {
    expect(practiceGroups(PRACTICES).map((group) => group.practices.map(({ id }) => id))).toEqual([
      ["husky"],
      ["squash"],
    ]);

    expect(
      practiceGroups(PRACTICES, { includeInvalid: true }).map((group) =>
        group.practices.map(({ id }) => id),
      ),
    ).toEqual([["husky", "broken"], ["squash"]]);
  });
});
