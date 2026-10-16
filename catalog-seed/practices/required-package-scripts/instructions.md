Every tracked package.json, including the root and nested packages, must declare
non-empty `scripts.lint`, `scripts.format`, and `scripts.build` commands. Wire
them to the repository's actual lint, formatting, and build tools. Do not add
echo-only, success-only, or comment-only placeholders to satisfy the rule.

For Oxforge repositories, use Oxlint for `lint` and Oxfmt with the shared
configuration for `format`. Keep the build command appropriate for the actual
framework or package. Preserve existing prerequisite builds and useful scripts.
The separate Vitest rule continues to require `scripts.test`.

This rule checks declarations and rejects obvious placeholders. It does not
execute commands, validate arbitrary script behavior, or require these commands
in CI. Use `format:check` for CI formatting validation where available; the
`format` script applies formatting locally.

All tracked manifests are checked regardless of language, directory, or private
status. A complete inventory with no manifests passes. Unreadable or malformed
manifests, truncated trees, and read-budget limits remain unknown unless a known
manifest fails. No generated, vendor, or fixture manifest is silently excluded.
