# Agent notes

- `catalog-seed/practices/` ships inside the Worker as the built-in practices (`src/practices/built-in.ts`). `CATALOG_REPO` (`aranlucas/practices`) layers overrides, custom practices, and `disabled` markers on top; `composeCatalog` in `src/practices/catalog.ts` decides the effective set.
- Worker tests run with no built-ins (an alias in `vitest.config.ts`); test layering in `test/practices/compose-catalog.test.ts`, or add sources to `test/helpers/no-built-in-sources.ts` within a test.
- The dashboard dev server (`pnpm ui:dev`) derives practice definitions from `catalog-seed/` through `src/ui/dev/fixtures.ts`; only repositories and outcomes are synthetic.

## Scripts: native first

Before adding a script file (`scripts/`, `bin/`, `tools/`, root `*.sh|*.py|*.mjs`) or a package script that runs one, take the first rung that works:

1. A flag or subcommand of a tool the repo already uses (`<tool> --help`).
2. Declarative config for that tool (`pnpm-workspace.yaml`, `vite.config.ts`, `vite.ui.config.ts`, `cloudflare.config.ts`, `vitest.config.ts`, `oxfmt.config.ts`).
3. A maintained plugin for that tool.
4. A one-line package.json script that calls a native command.
5. A test in the existing runner (Vitest with the Cloudflare plugin), for anything that asserts.
6. A custom script, only for behavior specific to this repo. Its first comment names the native rung it couldn't use and why. It has a test in the existing runner, and the PR that adds it quotes that comment.

## Code: libraries first

Before hand-writing general-purpose code, use a well-maintained library: actively released, widely adopted, typed, and a fit for this stack. Reach for one already in the dependencies first. Write custom code for domain logic and for the glue no library covers. A PR that adds a dependency says why it was picked; a PR that hand-writes something a library covers names the library and why it didn't fit.

- GitHub API access → `octokit` through the existing GitHub client.
- Dashboard server state → TanStack Query (`useQuery`/`useMutation`).
- Runtime validation → `zod`.
- Practice YAML parsing → `yaml` (`parseDocument`).

## Tests

- Before adding a test, identify the specific behavior, a credible mistake it should catch, and an independently justified expected result.
- Prefer small, fast, reliable tests whose failures identify the broken behavior. Use integration/E2E tests for interactions isolated tests cannot establish.
- Do not reproduce implementation logic in assertions or mocks.
- Protect contracts, not incidental internal structure.
- Distinguish temporary development scaffolding from checks worth maintaining.
- Never delete or weaken a failing test just to make the suite pass.
