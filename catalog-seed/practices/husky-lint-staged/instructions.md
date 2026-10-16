Declare Husky and lint-staged locally and initialize Husky through prepare or
postinstall, using the repository's package manager. Preserve existing build
steps and production/CI install guards; `husky || true` is supported for
installation, but lint-staged failures must still block commits.

Run lint-staged from the pre-commit hook, directly or through package scripts.
Adapt patterns and commands to the repository's languages and formatter.
Nonempty tasks may live in package.json or a separate JSON/YAML configuration;
do not move configuration or replace the hook merely to match the pnpm example.
Husky 9 runs user hooks through sh, so the user hook's executable bit is not
required. Verify the hook locally without committing.

Custom installers and hook directories, shell preambles, CLI config/cwd/diff
selectors, ambiguous configuration and JS/TS task files remain unknown for
review. Alias resolution is bounded and does not execute scripts. Preserve
working setup rather than rewriting it just to turn unknown green. The check
establishes static setup evidence; task execution and machine-local Git hook
activation still need verification.
