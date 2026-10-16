Install Husky using the target repository's package manager and keep the
pre-commit hook executable. Adapt the lint-staged patterns and commands to the
repository's language and formatter configuration, while retaining a
package.json prepare script that initializes Husky.

Declare Husky and lint-staged locally and configure non-empty lint-staged tasks
in package.json. The pre-commit hook must invoke lint-staged directly using the
repository's package manager. Preserve additional validation and build steps.
Both `husky || true` in prepare and runner options such as `--no-stash` are
supported. Unsupported shell control flow or an explicitly selected external
configuration stays unknown and requires review; Shipshape does not execute hooks.
