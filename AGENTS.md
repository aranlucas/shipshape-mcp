# Agent notes

- Production checks only the practices in `CATALOG_REPO` (`aranlucas/practices`), never `catalog-seed/`. When a practice is missing from the dashboard, run `pnpm catalog:diff` first.
- The dashboard dev server (`pnpm ui:dev`) renders `src/ui/dev/fixtures.ts`; add new seed practices there too so UI work sees the real catalog size.
