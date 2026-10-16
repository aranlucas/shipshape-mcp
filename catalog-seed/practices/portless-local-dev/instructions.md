Install `portless` as a dev dependency using the repository's package manager.
Make it the default `dev` command: for example, `portless run next dev` or
`portless run vite`. Keep one default local development path; replace redundant
backup dev scripts and wrapper scripts when the underlying tool can run directly.
Preserve preparation steps that the application actually needs.

The `portless-dev` check reads `package.json` at the evaluated commit. It recognizes
Next.js, Vite, Astro, Nuxt, React Router, cf and Wrangler development servers,
direct local executable runners, `exec`, and simple package-script aliases (at
most eight). A default web server without Portless or a Portless command without
a local dev dependency fails. A Portless script under a different name does not
satisfy the default `dev` requirement.

Packages without `scripts.dev` pass with an explicit no-server diagnostic;
libraries do not need an invented dev server. Custom commands, native/mobile
servers, compound setup, remote runners and unsupported flags require review.
Approve native exceptions through `appliesTo.exclude`. For monorepos, add checks
with `directory` set to each web package; each checked directory must declare its
own Portless dev dependency. The default check inspects the root package only.
Unreadable or malformed manifests remain unknown. No repository code is executed;
a pass establishes declarations, not working DNS, HTTPS or a successful server start.
