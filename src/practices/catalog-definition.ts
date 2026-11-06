import type { PracticeOrigin, PracticeSummary } from "../api/contract";
import { parsePractice, type ParsedPractice } from "./schema";

export interface CatalogPractice {
  id: string;
  folder: string;
  yaml: string;
  instructions: string | null;
  files: Record<string, string>;
  parsed: ParsedPractice;
  /** Absent on catalog-repository practices that don't shadow a built-in. */
  origin?: PracticeOrigin;
  /** An override whose files are identical to the built-in it shadows. */
  matchesBuiltIn?: boolean;
}

export interface Catalog {
  repo: string;
  /** Version of the practice set; results recorded against another version are stale. */
  sha: string;
  practices: CatalogPractice[];
}

/** What the catalog repository contributes; stored in D1 as loaded. */
export interface CatalogLayer extends Catalog {
  /** Built-in practice ids the repository turns off with a `disabled` marker. */
  disabled: string[];
}

/** Built-in practices overlaid by the catalog repository. */
export interface EffectiveCatalog extends Catalog {
  /** Catalog repository commit the set was composed from. */
  commit: string;
  /** Built-in practices the catalog repository turns off. */
  disabled: CatalogPractice[];
}

export function parseCatalogSources(sources: Record<string, string>): CatalogPractice[] {
  const folders = new Map<string, Map<string, string>>();

  for (const [path, content] of Object.entries(sources)) {
    const match = /^practices\/([^/]+)\/(.+)$/u.exec(path);

    if (match?.[1] && match[2]) {
      (folders.get(match[1]) ?? folders.set(match[1], new Map()).get(match[1]))?.set(
        match[2],
        content,
      );
    }
  }

  return [...folders]
    .flatMap(([id, files]): CatalogPractice[] => {
      const yaml = files.get("practice.yml");

      if (yaml === undefined || files.has("disabled")) {
        return [];
      }

      return [
        {
          id,
          folder: id,
          yaml,
          instructions: files.get("instructions.md") ?? null,
          files: Object.fromEntries([...files].filter(([path]) => path.startsWith("files/"))),
          parsed: parsePractice(yaml, id),
        },
      ];
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

export function practiceSummary(practice: CatalogPractice): PracticeSummary {
  if (practice.parsed.ok) {
    return {
      id: practice.id,
      title: practice.parsed.practice.title,
      summary: practice.parsed.practice.summary,
      kind: practice.parsed.practice.kind,
      valid: true,
      error: null,
      origin: practice.origin ?? "custom",
      matchesBuiltIn: practice.matchesBuiltIn ?? false,
    };
  }

  const issue = practice.parsed.issues[0];

  return {
    id: practice.id,
    title: "",
    summary: "",
    kind: "files",
    valid: false,
    error: `${issue?.path ?? ""}: ${issue?.message ?? "invalid practice"}`,
    origin: practice.origin ?? "custom",
    matchesBuiltIn: practice.matchesBuiltIn ?? false,
  };
}
