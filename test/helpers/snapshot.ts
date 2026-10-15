import type { RepoSnapshot } from "@/practices/snapshot";
import type { StoredRepository } from "@/practices/store";
import type { BranchProtectionFact } from "@/drift/evaluate";

export type SnapshotValue =
  | string
  | number
  | boolean
  | null
  | SnapshotValue[]
  | { [key: string]: SnapshotValue };

export const snapshotRepository: StoredRepository = {
  fullName: "octo/demo",
  owner: "octo",
  name: "demo",
  installationId: 42,
  private: false,
  archived: false,
  fork: false,
  language: "TypeScript",
  defaultBranch: "main",
  pushedAt: "2026-08-29T00:00:00Z",
  url: "https://github.com/octo/demo",
};

export interface SnapshotOptions {
  paths?: Iterable<string>;
  files?: Readonly<Record<string, string | { error: string }>>;
  settings?: Record<string, SnapshotValue> | { error: string } | null;
  truncated?: boolean;
  protection?: Map<string, BranchProtectionFact> | Record<string, BranchProtectionFact>;
  tree?: { paths?: Iterable<string>; truncated?: boolean } | null;
  treeError?: string | null;
  repo?: StoredRepository;
  headSha?: string | null;
}

export function makeSnapshot(options: SnapshotOptions = {}): RepoSnapshot {
  const tree =
    options.tree === null
      ? null
      : {
          paths: new Set(options.tree?.paths ?? options.paths ?? []),
          truncated: options.tree?.truncated ?? options.truncated ?? false,
        };

  const protection = new Map<string, BranchProtectionFact>();

  if (options.protection instanceof Map) {
    for (const [branch, fact] of options.protection) {
      protection.set(branch, fact);
    }
  } else if (options.protection) {
    const record = options.protection ?? {};

    for (const branch of Object.keys(record)) {
      const fact = record[branch];
      protection.set(branch, fact);
    }
  }

  return {
    repo: options.repo ?? snapshotRepository,
    headSha: options.headSha ?? "a".repeat(40),
    tree,
    treeError: options.treeError ?? null,
    files: new Map(Object.entries(options.files ?? {})),
    settings: options.settings ?? null,
    protection,
  };
}
