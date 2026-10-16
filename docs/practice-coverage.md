# Practice coverage and adoption

The live catalog is a separate private repository. Editing `catalog-seed` does not migrate it. Deploy support for new checks first, then review and copy the selected definitions into the catalog through its normal editing workflow. Never replace owner-authored instructions or exceptions wholesale. Existing check types keep their existing semantics.

## Added semantic checks

- `oxforge`: optional `directory` (default `.`), `minimumVersion` (default `0.2.0`). Checks the manifest's supported lower bound, a single discovered Oxlint entry point, inherited base/recommended policy and locally duplicated anti-slop plugin registrations. Reads relative JSON/JSONC inheritance at the captured commit with the existing 64-file/512-KB limits. Does not execute repository code. Unread, dynamic, cyclic, ambiguous and unresolved declarations remain unknown.
- `oxforge-format`: optional `directory` (default `.`). Reads the package manifest and `oxfmt.config.ts` at the captured commit. Accepts shared Oxforge format exports, static project overrides and the `format()` helper. Requires enabled `sortTailwindcss` when any dependency section declares `tailwindcss`, including catalog/workspace versions. Stylesheet paths remain project-specific. Static syntax is parsed with Acorn; dynamic code, mutations, TypeScript-only syntax and unsupported wrappers remain unknown without execution. Missing files in a complete inventory fail; unread files remain unknown. Replace the formatter `file-matches` entry in the live Oxforge practice with this check after deploying support.
- `dependabot-grouped`: optional `path` (default `.github/dependabot.yml`). Checks version 2, directory declarations, npm/GitHub Actions entries sharing one group, wildcard patterns, and that group's one-PR limit. Other ecosystems remain unknown pending an appropriate evaluator. Security updates are not promised to fit the version-update PR limit.

Oxforge checks deliberately do not claim the active lint command ran, the lockfile resolved a range, every local override is justified, or arbitrary scripts are unused. In particular, passing shared inheritance must not be read as proof that all shared rules remain enabled. The formatter check establishes shared inheritance and Tailwind opt-in; it does not verify stylesheet contents or run the formatter.

## Evidence behind the defaults

- [Oxforge base policy](https://github.com/aranlucas/oxforge/blob/main/configs/base.json) keeps consistent-return and readonly-parameter rules off and centralizes anti-slop policy.
- [delivery-dash test aliases](https://github.com/aranlucas/delivery-dash/blob/main/tsconfig.test-paths.json) map `@/*` to source and `@test/*` to root tests. Its Vitest config keeps dedicated integration scenarios separate.
- [react-hook-form-mantine Vitest projects](https://github.com/aranlucas/react-hook-form-mantine/blob/main/vitest.config.ts) combine root unit tests with Storybook browser tests. A Playwright browser provider alone is not evidence that a standalone Playwright e2e config is missing.
- [ai-shopping-mcp CI](https://github.com/aranlucas/ai-shopping-mcp/blob/main/.github/workflows/ci.yml) uses Ubuntu and `pnpm/setup` with locked install. Building views before tests is an actual prerequisite, not a redundant deployment-provider build.
- [grocery-agent-mobile scripts](https://github.com/aranlucas/grocery-agent-mobile/blob/main/package.json) use Expo lint and an Oxlint Tailwind add-on. A native-framework exception must be explicit rather than silently replacing the native toolchain.

These were inspected on 2026-10-15. They are examples of specific decisions, not blanket certification of those repositories.

## Remaining checks requiring review or a future evaluator

The eight seed practices do not cover every engineering preference. The CI seed still establishes only file presence, a pnpm/setup reference and root contents-read permissions; it does not prove one CI workflow, appropriate Ubuntu/public versus private self-hosted runners, locked setup, or absence of duplicate install/cache/provider-build work. The auto-merge seed checks file presence, not workflow safety or required-check enforcement.

Vitest over node:test, root/package test placement, source aliases without `src` in imports, and standalone Playwright e2e paths/configuration need dedicated semantic evaluators. Framework, native, generated, vendor and Storybook exceptions must be considered before failing them. Preserve meaningful security, domain and clinical contracts; static text matching cannot establish behavior-focused test quality. Remove only independently proven unused scripts, never diagnostic tools just because CI does not invoke them.

Repository transfers, inaccessible installations, permission-denied reads and truncated inventories are availability problems. Do not turn them into missing-standard failures. The UI must keep unknown and pending results separate from failed checks.
