Remove direct Wrangler dependencies and CLI invocations. Use the supported `cf`
command where Cloudflare tooling is needed; other repositories do not need to
install cf. Preserve application-specific build steps and database migration gates.

The `cloudflare-cf-cli` check applies across eligible repositories, without a root
package.json or Cloudflare-project prerequisite. At the captured commit it reads:

- Every tracked root and nested package.json: reject a `wrangler` key in
  dependencies, devDependencies, optionalDependencies or peerDependencies (including
  npm aliases pointing to Wrangler), and
  inspect every package script for explicit Wrangler CLI invocations.
- Every .github/workflows/*.yml or *.yaml: inspect run steps (including parallel
  steps) and reject cloudflare/wrangler-action, including full SHA pins.
- Tracked composite action.yml/action.yaml files: inspect their run and uses steps.

The command recognizer supports direct calls, local binary paths, explicit
pnpm/yarn exec or dlx, npm exec/npx, bun x/bunx, common env/exec wrappers and shell
command lists. Comments and quoted prose are not invocation evidence. Ambiguous
package aliases, indirect shells, command substitutions and reusable workflows
require review. The check neither executes repository code nor follows arbitrary
shell/JavaScript files, Dockerfiles or remote action implementations. A pass
establishes absence only in the inspected declarations and recognized commands.

Transitive Wrangler entries in lockfiles, documentation mentions and wrangler.*
configuration filenames alone do not fail. No cf dependency is required.
Unreadable or malformed relevant files and incomplete inventories remain unknown
unless observed evidence proves a failure. Reads share the existing 64-file and
512-KB-per-file budgets. Keep explicit owner-approved exceptions in the catalog.

Deploy the updated evaluator before adopting this revised definition in the
separate live catalog. The stable check ID is retained; the previous directory
option is removed because this policy now inspects the entire repository.
