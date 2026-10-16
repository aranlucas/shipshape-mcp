Declare pnpm or Bun in the root package.json packageManager field (or devEngines.packageManager).
Migrate npm lockfiles to pnpm-lock.yaml or bun.lock and replace explicit npm/npx
commands in package scripts, workflows, and composite actions. Preserve dependency
versions and use frozen installs in CI. Dependabot still uses the npm ecosystem
identifier for pnpm and Bun; registry URLs and explanatory prose are not violations.
