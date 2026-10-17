# Agent notes

- `catalog-seed/practices/` ships inside the Worker as the built-in practices (`src/practices/built-in.ts`). `CATALOG_REPO` (`aranlucas/practices`) layers overrides, custom practices, and `disabled` markers on top; `composeCatalog` in `src/practices/catalog.ts` decides the effective set.
- Worker tests run with no built-ins (an alias in `vitest.config.ts`); test layering in `test/practices/compose-catalog.test.ts`, or add sources to `test/helpers/no-built-in-sources.ts` within a test.
- The dashboard dev server (`pnpm ui:dev`) renders `src/ui/dev/fixtures.ts`; add new built-in practices there too so UI work sees the real catalog size.
