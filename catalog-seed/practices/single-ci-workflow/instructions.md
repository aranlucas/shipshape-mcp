Adapt the CI workflow steps to the target repository's package manager, build,
lint, typecheck, and test commands. Keep the workflow's contents permission at
read and use the setup action appropriate for the repository's package manager;
this starter convention assumes pnpm.

Declare a non-empty `scripts.test` in the root `package.json` and invoke that
script in `.github/workflows/ci.yml`, for example with `pnpm test` or
`bun run test`. Running Vitest directly in CI does not establish that the
package test script is used. The separate Vitest practice checks its contents.
The `ci-test-script` check recognizes direct npm, pnpm, Yarn, and Bun script
commands, simple script aliases (up to eight), and nested parallel steps.
Use a root-directory test step without a condition or ignored failures.
Compound shell commands, selectors/flags, conditional or matrix jobs, other
working directories, and reusable workflows require review. External Action
names and comments are not evidence that the test script runs. This static
check does not execute tests or establish successful CI runs.

On the repository's default branch, enable **Require status checks to pass
before merging** in its branch protection rule. Add every job from
`.github/workflows/ci.yml` using its `name` when set, otherwise its job ID.
For example, `jobs.ci` without a name reports the required check `ci`, not
`CI` or `ci.yml`. Keep other required checks and existing protections intact.
Run CI first if GitHub does not yet offer the check names for selection.

When renaming a CI job, update the required check name too. Matrix jobs,
dynamic names, reusable workflows and duplicate job names need manual review;
Shipshape reports those cases as unknown. Shipshape reads protection settings
and reports missing checks; it does not change repository settings.
