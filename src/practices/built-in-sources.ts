/// <reference types="vite/client" />

/**
 * catalog-seed/ bundled into the Worker at build time, keyed by catalog path
 * (`practices/<id>/…`). Worker tests alias this module to an empty set.
 */
const modules = import.meta.glob<string>("../../catalog-seed/practices/**/*", {
  query: "?raw",
  import: "default",
  eager: true,
  // Includes dot-directories such as husky-lint-staged/files/.husky/.
  exhaustive: true,
});

export const BUILT_IN_SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(modules).map(([path, content]) => [
    path.slice(path.indexOf("practices/")),
    content,
  ]),
);
