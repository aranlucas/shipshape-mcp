# Security policy

Shipshape is intentionally read-only. It requests only GitHub's `read:user`
OAuth scope and refuses private repositories before collecting repository data.
It does not expose a mutation tool, clone code, or execute repository content.

Please report vulnerabilities through GitHub's private vulnerability reporting
flow for this repository. Do not include active credentials in a public issue.

Useful reports include:

- OAuth redirect, consent, state, or CSRF bypasses
- cross-user data exposure
- a path that reaches a private repository
- server-side request forgery or unsafe client-metadata rendering
- a GitHub API mutation reachable from an MCP tool

The supported deployment is the current `main` branch on Cloudflare Workers.
Security fixes are prioritized over feature compatibility.
