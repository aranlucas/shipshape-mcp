import { BUILT_IN_SOURCES } from "./built-in-sources";
import type { CatalogPractice } from "./catalog-definition";
import { parseCatalogSources } from "./catalog-definition";

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

export interface BuiltInSet {
  practices: CatalogPractice[];
  version: string;
}

let bundled: BuiltInSet | undefined;

/** The practices bundled into this deploy, parsed once per content version. */
export function bundledBuiltIns(): BuiltInSet {
  const version = builtInVersion(BUILT_IN_SOURCES);

  if (bundled?.version !== version) {
    bundled = {
      practices: parseCatalogSources(BUILT_IN_SOURCES).map((practice) => ({
        ...practice,
        origin: "built-in",
      })),
      version,
    };
  }

  return bundled;
}
