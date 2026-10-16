Use Cloudflare's `cf` CLI for Worker development, builds and deployment. Install
`cf` as a local dev dependency with pnpm or Bun and remove the direct `wrangler`
dependency after migrating its consumers. Simplify obsolete migration guides,
fallback scripts and build wrappers once equivalent cf behavior is verified.
Preserve application-specific build steps and database migration gates.

The `cloudflare-cf-cli` check detects a Cloudflare project from a direct `cf` or
`wrangler` dependency or one of `cloudflare.config.ts`, `wrangler.jsonc`,
`wrangler.json`, or `wrangler.toml` in the checked directory. It requires a nonempty
`devDependencies.cf` and fails a direct Wrangler dependency. Transitive Wrangler
dependencies and documentation references are outside this declaration check.
Packages with neither dependency nor configuration pass with an explicit
no-Cloudflare diagnostic only when the repository inventory is complete.

The check reads the manifest and captured tree, without importing configuration
or running commands. It does not establish that scripts, workflows, generated
types, deployment configuration or hosted Workers Builds have migrated correctly.
Verify those consumers with the installed CLI before removing tooling. Record
any required unsupported CLI operation as an explicit catalog exception instead
of adding a silent fallback. For monorepos, add a check with `directory` set to
each Worker package. Unreadable or malformed manifests and incomplete evidence
remain unknown unless an observed declaration proves a failure.
