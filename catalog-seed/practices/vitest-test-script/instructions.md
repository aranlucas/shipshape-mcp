Every tracked package.json, including the repository root and nested packages,
must declare a non-empty scripts.test that runs Vitest. Use `"test": "vitest run"`
and install Vitest using the repository's package manager.

Direct Vitest commands and npm, pnpm, Yarn, and Bun executable runners are
supported, including Vitest options. Help, version, list, and initialization
commands do not run tests. Script aliases, wrappers, and compound shell commands
require review; the evaluator never executes repository code.

All tracked manifests are checked regardless of language, directory, or private
status. A repository with no manifests passes. Unreadable or malformed JSON,
truncated trees, and read-budget limits remain unknown unless a known manifest
fails. No manifest is silently excluded as generated, vendor, or fixture content.
