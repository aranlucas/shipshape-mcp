# Correctness and reliability audit — 2026-11-06

Baseline: remote `main` at `6217246` (merged untangle pass). Clean isolated worktree; no local tests or builds are authorized. This is a behavior audit, not structural cleanup.

## Inventory and boundaries

- HTTP entry (`src/index.ts`): public landing/resource metadata, signed GitHub webhook intake, authenticated MCP, and session-protected dashboard/API. Owner identity, installation account allowlists, CSRF/browser binding, preview read-only enforcement, and safe error responses are trust boundaries.
- GitHub inventory and catalog: installation-scoped clients, validated/paginated reads, completeness checks before deletion, immutable commit/blob reads, and catalog-only Git Data writes. Catalog changes must preserve branch history and reject competing non-fast-forward updates.
- Evaluation pipeline: durable D1 runs/jobs/outbox, at-least-once Queue delivery, lease/generation/catalog guards, bounded attempts, delayed retry, recovery of expired jobs, and snapshot cache fallback. Results must not claim success for unavailable evidence.
- Practice engine: YAML/schema validation, built-in/override/disabled composition, applicability and file/settings/workflow checks; effective catalog SHA includes bundled definitions. Worker tests deliberately omit built-ins; composition tests cover layering separately.
- Dashboard: TanStack Query reads/mutations, overview/repository evidence, practice create/edit/disable/reset, refresh and navigation. Development fixture API uses real catalog-seed definitions with synthetic outcomes and no production credentials.
- Deployment/CI: existing Vitest node/Worker projects, lint/type checks, preview/production dry-run builds. CI is the sole test/build execution venue.

## Confirmed findings before implementation

1. **High — every catalog commit loses its ancestry.** `src/github/catalog-write.ts`, `commitCatalogChange`, creates a Git commit without `parents`. GitHub documents that this creates a root commit. Updating an existing branch with `force: false` then rejects it as non-fast-forward, so dashboard save/delete/reset fails. Expected: parent is the exact base read earlier, preserving history and conflict detection. High confidence; independently identified by review child. Existing mock accepts every ref update and its assertion checks only message/tree, missing the Git contract.
2. **Medium — valid YAML IDs cannot create a practice.** `src/ui/views/practice-editor.tsx`, `yamlId`, extracts IDs by line regex. `id: audit-example # explanation` and a quoted `"id"` key are valid YAML accepted by the server parser but yield no target in the new-practice form. Expected: extract the actual YAML scalar with the existing `yaml` library, validate its slug, preserve server validation and show invalid input errors. High confidence from parser/regex inspection.

3. **High — creating a practice without instructions fails.** `commitCatalogChange` emits a null-SHA deletion for `instructions.md` even when that path does not exist. The UI sends `instructions: null` for an empty instructions tab. GitHub tree creation explicitly rejects deletion of nonexistent files. Only delete an existing blob; preserve the existing mode/type. High confidence from [GitHub tree contract](https://docs.github.com/en/rest/git/trees#create-a-tree).
4. **High — dashboard mutation API lacks origin protection.** `src/web/routes.ts` checks same-origin only for logout. A malicious same-site sibling origin can send a cookie-bearing simple POST with text/plain JSON to refresh or reset; SameSite=Lax does not isolate sibling origins. Reuse the existing origin/fetch-site check for authenticated unsafe API requests. Existing same-origin text/plain API compatibility remains supported.

## Review evidence and rejected hypotheses

- Queue duplicate delivery is not itself a defect: claims and writes use durable job identity, lease tokens, head generation and installation guards; recovery handles crashed/expired attempts.
- Partial GitHub inventory is not treated as complete: pagination truncation and total-count reconciliation reject destructive pruning for an incomplete installation read.
- Cache failures are intentionally optional and fall back to live reads; cached inputs include installation/repo/head identity. Mutable settings bypass immutable-input shortcuts.
- Built-ins are intentionally excluded from Worker test fixtures, not missing from production; catalog composition adds the running built-in set.
- Owner-only app architecture is intentional; do not invent multi-tenant product requirements. No credentials or production resources will be introduced for validation.

## Validation plan

Regressions protect the Git parent/ref contract and valid-YAML practice creation. CI will demonstrate the same assertions fail against the baseline implementation and pass with fixes. Existing tests/builds remain intact.

The requested tester-army framework is applicable to the existing dashboard. Published registry inspection confirmed `e2e@0.23.0` and `@e2e-dev/web@0.15.5`, requiring Node `^22.22.3 || >=24.8.0`. Current quickstart, web and GitHub Actions/CI docs were read. Use deterministic locators/actions/assertions without agent/model credentials against the existing development fixture server. This covers real client navigation and create/edit/delete flows, not GitHub OAuth or live GitHub writes; Worker/API/protocol regressions retain those controlled boundaries. Upload `.e2e` failure evidence in CI. No local test/build executions.

## Independent review and implementation

A native independent reviewer examined authentication, API/MCP, catalog writes, inventory and the patch. It independently found missing commit ancestry, nonexistent instructions deletion and missing API origin protection. Implementation review accepted the narrow fixes, corrected the baseline fetch to a full Git OID, and recommended bounded YAML alias resolution, now included. No local tests/builds ran.

Added dependencies are the user-requested tester-army runner and compatible published web engine, pinned exactly in the lockfile; no unrelated upgrades. Existing `yaml` and `zod` handle YAML extraction/validation rather than custom parsing. Install used `--ignore-scripts` after inspecting package lifecycle scripts; no test/build hooks ran.

CI baseline reproduction selects seven assertion cases against the original three source files, verifies exactly seven failures and zero passes, and restores the patched files before existing checks. Browser failure traces/video and JUnit reports upload from `.e2e`. CI/PR results: pending.

First CI run [42305668485](https://github.com/aranlucas/shipshape-mcp/actions/runs/42305668485) established all seven baseline failures and passed the deterministic browser lifecycle, typecheck, preview build and production dry run. It caught lint issues in new tests, two legacy API requests omitting the now-required browser Origin header, and the missing draft guard on the new browser job. These are corrected without changing assertions or bypassing the security guard; full CI rerun pending. The Cloudflare bot comment reports its existing automatic preview succeeded; it requests no changes.
