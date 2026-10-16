Adapt the CI workflow steps to the target repository's package manager, build,
lint, typecheck, and test commands. Keep the workflow's contents permission at
read and use the setup action appropriate for the repository's package manager;
this starter convention assumes pnpm.

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
