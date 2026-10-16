import { describe, expect, it } from "vitest";
import type { Practice } from "@/practices/schema";
import { applies, globMatches } from "@/practices/applies";
import { makeSnapshot, snapshotRepository } from "@test/helpers/snapshot";

type PracticeOverrides = Omit<Partial<Practice>, "appliesTo"> & {
  appliesTo?: Partial<Practice["appliesTo"]>;
};

function practice(overrides: PracticeOverrides = {}): Practice {
  const { appliesTo, ...rest } = overrides;

  const selection: Practice["appliesTo"] = {
    include: appliesTo?.include ?? ["*"],
    exclude: appliesTo?.exclude ?? [],
    archived: appliesTo?.archived ?? false,
    forks: appliesTo?.forks ?? false,
  };

  if (appliesTo?.owners) {
    selection.owners = appliesTo.owners;
  }

  if (appliesTo?.visibility) {
    selection.visibility = appliesTo.visibility;
  }

  if (appliesTo?.languages) {
    selection.languages = appliesTo.languages;
  }

  if (appliesTo?.hasFiles) {
    selection.hasFiles = appliesTo.hasFiles;
  }

  return {
    version: 1,
    id: "practice",
    title: "Practice",
    summary: "A practice for testing selection.",
    kind: "files",
    appliesTo: selection,
    checks: [{ type: "file-exists", path: "README.md", absent: false }],
    ...rest,
  };
}

describe("practice applicability", () => {
  it("keeps both visibilities eligible unless the practice selects one", () => {
    const privateRepo = { ...snapshotRepository, private: true };
    const publicOnly = practice({ appliesTo: { visibility: "public" } });
    const privateOnly = practice({ appliesTo: { visibility: "private" } });

    expect(applies(practice(), privateRepo, makeSnapshot())).toBe(true);
    expect(applies(practice(), snapshotRepository, makeSnapshot())).toBe(true);
    expect(applies(publicOnly, privateRepo, makeSnapshot())).toBe(false);
    expect(applies(publicOnly, snapshotRepository, makeSnapshot())).toBe(true);
    expect(applies(privateOnly, privateRepo, makeSnapshot())).toBe(true);
    expect(applies(privateOnly, snapshotRepository, makeSnapshot())).toBe(false);
  });

  it("matches repository globs case-insensitively in linear time", () => {
    expect(globMatches("svc-*", "svc-api")).toBe(true);
    expect(globMatches("svc-*", "SVC-api")).toBe(true);
    expect(globMatches("svc-?", "svc-ab")).toBe(false);
    expect(globMatches("*-api", "billing-api")).toBe(true);
    expect(globMatches("*a*b*", "xxaxxbxx")).toBe(true);
    expect(globMatches("*a*b", "xxaxxbxx")).toBe(false);
    expect(globMatches("*", "")).toBe(true);

    const started = performance.now();
    expect(globMatches(`${"*a".repeat(50)}b`, "a".repeat(100))).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("matches owners case-insensitively", () => {
    expect(
      applies(practice({ appliesTo: { owners: ["OCTO"] } }), snapshotRepository, {
        tree: makeSnapshot({}).tree,
      }),
    ).toBe(true);
  });

  it("requires an exact GitHub language name", () => {
    expect(
      applies(
        practice({ appliesTo: { languages: ["JavaScript"] } }),
        snapshotRepository,
        makeSnapshot({}),
      ),
    ).toBe(false);
    expect(
      applies(
        practice({ appliesTo: { languages: ["TypeScript"] } }),
        snapshotRepository,
        makeSnapshot({}),
      ),
    ).toBe(true);
  });

  it("applies include and exclude repository globs", () => {
    expect(
      applies(practice({ appliesTo: { include: ["dem*"] } }), snapshotRepository, makeSnapshot({})),
    ).toBe(true);
    expect(
      applies(
        practice({ appliesTo: { include: ["*"], exclude: ["demo"] } }),
        snapshotRepository,
        makeSnapshot({}),
      ),
    ).toBe(false);
  });

  it.each(["octo/demo", "OCTO/DEMO", "octo/dem?", "*/demo", "oct*/dem*"])(
    "matches owner-qualified include pattern %s",
    (pattern) => {
      const selected = practice({ appliesTo: { include: [pattern] } });

      expect(applies(selected, snapshotRepository, makeSnapshot())).toBe(true);
    },
  );

  it("keeps qualified selectors scoped to their owner", () => {
    const included = practice({ appliesTo: { include: ["other/demo"] } });
    const excluded = practice({ appliesTo: { exclude: ["other/demo"] } });

    expect(applies(included, snapshotRepository, makeSnapshot())).toBe(false);
    expect(applies(excluded, snapshotRepository, makeSnapshot())).toBe(true);
  });

  it("excludes qualified repositories before requiring a readable tree", () => {
    const selected = practice({
      appliesTo: { exclude: ["OCTO/dem*"], hasFiles: ["package.json"] },
    });

    expect(applies(selected, snapshotRepository, makeSnapshot({ tree: null }))).toBe(false);
  });

  it("still requires files after matching a qualified selector", () => {
    const selected = practice({
      appliesTo: { include: ["octo/demo"], hasFiles: ["package.json"] },
    });

    expect(applies(selected, snapshotRepository, makeSnapshot())).toBe(false);
    expect(applies(selected, snapshotRepository, makeSnapshot({ tree: null }))).toBe("unknown");
    expect(applies(selected, snapshotRepository, makeSnapshot({ paths: ["package.json"] }))).toBe(
      true,
    );
  });

  it("filters archived repositories and honors the archived flag", () => {
    const archived = { ...snapshotRepository, archived: true };
    expect(applies(practice(), archived, makeSnapshot({ repo: archived }))).toBe(false);
    expect(
      applies(
        practice({ appliesTo: { archived: true } }),
        archived,
        makeSnapshot({ repo: archived }),
      ),
    ).toBe(true);
  });

  it("filters forks and honors the forks flag", () => {
    const fork = { ...snapshotRepository, fork: true };
    expect(applies(practice(), fork, makeSnapshot({ repo: fork }))).toBe(false);
    expect(
      applies(practice({ appliesTo: { forks: true } }), fork, makeSnapshot({ repo: fork })),
    ).toBe(true);
  });

  it("requires every hasFiles path in a complete tree", () => {
    const selected = practice({ appliesTo: { hasFiles: ["README.md", "package.json"] } });
    expect(
      applies(selected, snapshotRepository, makeSnapshot({ paths: ["README.md", "package.json"] })),
    ).toBe(true);
    expect(applies(selected, snapshotRepository, makeSnapshot({ paths: ["README.md"] }))).toBe(
      false,
    );
  });

  it("returns unknown when hasFiles needs an unreadable tree", () => {
    const selected = practice({ appliesTo: { hasFiles: ["README.md"] } });
    expect(applies(selected, snapshotRepository, makeSnapshot({ tree: null }))).toBe("unknown");
  });

  it("returns unknown when a required path is missing from a truncated tree", () => {
    const selected = practice({ appliesTo: { hasFiles: ["README.md"] } });
    expect(
      applies(
        selected,
        snapshotRepository,
        makeSnapshot({ paths: ["package.json"], truncated: true }),
      ),
    ).toBe("unknown");
  });
});
