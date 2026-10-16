# Practices from recurring requests

Reviewed the available Shipshape history and related repository tooling chats on
2026-10-15. These are personal engineering preferences supported by Lucas's own
requests. Preserve existing catalog exceptions when adopting them.

## Added to the seed catalog

- **Portless as the default local web dev command, installed locally.** In
  [Improve Portless Local Development](t3-thread://v1/0301f7fa-30a0-4c7f-b002-7c7749608cac),
  Lucas requested this across a batch of repositories, then repeated that it should
  be the default, have no backup scripts, and be installed as a dev dependency.
  The `portless-local-dev` practice checks the default command and local dependency;
  cleanup of redundant scripts still needs review.
- **Cloudflare cf CLI with obsolete Wrangler tooling removed.**
  [Review Cloudflare CLI Migrations](t3-thread://v1/8807f673-9031-4595-988d-f2f9ad3542dd)
  requested this across eleven repositories, with no fallbacks or migration guide.
  The preference recurred in
  [Restore Vitest 4 and Build](t3-thread://v1/7a7fa6ea-a4b4-4f45-b9c4-18e060ac50e6),
  [Optimize GitHub CI Workflows](t3-thread://v1/cb1ecc4b-b768-405b-99a5-366a75e0a2b3),
  and [Simplify Preview Build Checks](t3-thread://v1/88fcaf69-8f9f-4b0b-ae28-8e4319568491).
  The `cloudflare-cf-cli` practice checks direct CLI dependency declarations.
  Actual command migration and removal of unnecessary wrappers require verification.

## Recurring preferences already represented

- **pnpm or Bun, preserving a Bun project's identity:** `preferred-package-manager`
  and `pnpm-setup`. See
  [Fix CI Workflow Setup Action](t3-thread://v1/b685b3bc-0fb7-4e54-816f-6b25e7c707af),
  [Prefer Bun in Agent Instructions](t3-thread://v1/1a5b8b74-ebfc-42bd-80fa-1ccf57456ea2)
  and [Use Bun for Traverse Setup](t3-thread://v1/3604e90a-e568-4806-951e-5107d2763405).
  The CI seed still has a literal pnpm/setup requirement; that known gap needs a
  package-manager-aware CI evaluator rather than imposing pnpm on Bun repositories.
- **Shared Oxforge and effective Tailwind sorting:** `oxforge-lint-format`.
  Requests recur in
  [Install Oxforge Across TypeScript Projects](t3-thread://v1/8a6cecc9-86b0-4348-a4ce-442ff209d813),
  [Fix Oxforge Tailwind Formatting Configuration](t3-thread://v1/67d8d560-0877-4cda-bace-b54ae8b45728),
  and [Fix Oxforge Lint Format Rule](t3-thread://v1/cc951832-7dd8-4410-9654-d30bbdbf9d49).
  Static configuration evidence does not establish that sorting ran successfully.
- **Vitest and usable package scripts:** `vitest-test-script`,
  `required-package-scripts`, and `single-ci-workflow`. See
  [Require Vitest Test Scripts](t3-thread://v1/eb286d9f-e484-438c-b714-efefdc0d33fc)
  and [Add Test Script to CI Workflow](t3-thread://v1/1a842efb-3146-41dd-a329-8d751a4e0c46).
  Later requests to update Vitest supersede the temporary Vitest 4 workaround;
  no permanent major-version pin was added.
- **Husky plus lint-staged:** `husky-lint-staged`, requested portfolio-wide in
  [Add Husky and oxlint Pre-commit Hooks](t3-thread://v1/abb740c4-892f-4f1a-ab1f-d2c12869f4c2).
- **Squash-only merges, branch-update suggestions, and auto-merge where available:**
  existing settings practices. See
  [Standardize Pull Request Merge Settings](t3-thread://v1/a56bac78-ad01-463b-aefa-9b0ca7d9bc40)
  and [Add PR Branch Update Suggestion Rule](t3-thread://v1/5dc66788-67a2-40bc-b0c7-e7954bac7cb4).
  Preserve the explicit instruction not to penalize private repositories for
  unavailable auto-merge.

## Requests kept scoped to their applications

React Query changes addressed dashboard refresh behavior. Shadcn and canonical
Tailwind classes addressed particular UI systems. React Doctor audits, dependency
updates, PR creation and rebases recur as work requests, but the reviewed messages
do not establish a universal repository configuration to enforce. Avoid inventing
static checks for behavior that needs interaction, runtime evidence or judgement.

Deploy the evaluator before adopting the new definitions in the separate live
catalog. See [practice coverage](practice-coverage.md) for check boundaries.
