import { BUILT_IN_SOURCES } from "./built-in-sources";
import type { CatalogPractice } from "./catalog";
import { parsePractice } from "./schema";

/** FNV-1a over sorted paths and contents: changes whenever any bundled file does. */
export function builtInVersion(sources: Record<string, string>): string {
  let hash = 0x81_1c_9d_c5;

  for (const path of Object.keys(sources).toSorted()) {
    for (const character of `${path}\0${sources[path]}\0`) {
      hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 0x01_00_01_93);
    }
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

function builtInPractices(sources: Record<string, string>): CatalogPractice[] {
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

      if (yaml === undefined) {
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
          origin: "built-in",
        },
      ];
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

export interface BuiltInSet {
  practices: CatalogPractice[];
  version: string;
}

let bundled: BuiltInSet | undefined;

/** The practices bundled into this deploy, parsed once per content version. */
export function bundledBuiltIns(): BuiltInSet {
  const version = builtInVersion(BUILT_IN_SOURCES);

  if (bundled?.version !== version) {
    bundled = { practices: builtInPractices(BUILT_IN_SOURCES), version };
  }

  return bundled;
}
