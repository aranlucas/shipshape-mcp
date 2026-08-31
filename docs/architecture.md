# Architecture

Shipshape is a stateless, read-only MCP server on Cloudflare Workers.

```text
MCP client
   |  OAuth 2.1 + PKCE
   v
Cloudflare OAuth provider ---- KV (short-lived grants and encrypted props)
   |
   v
Stateless MCP handler ---- GitHub REST API 2026-03-10
   |                              |
   +---- normalized facts <-------+
                 |
                 v
       deterministic rules and scores
```

## Boundaries

- The MCP endpoint is `/mcp` using Streamable HTTP.
- Cloudflare's `workers-oauth-provider` owns the MCP authorization server;
  `oauth4webapi` handles the upstream GitHub authorization-code exchange and
  bearer request with standards-checked responses.
- GitHub authenticates the user with only `read:user`. Repository tools reject
  private repositories even if an upstream credential could see one.
- The Worker performs only `GET` and `HEAD` requests to `api.github.com`.
- Repository responses are bounded by page limits, timeouts, concurrency caps,
  and response-size checks. A repository is never cloned or executed.
- OAuth state is one-time, browser-bound, and short-lived. Dynamic client
  metadata is escaped before it reaches HTML, and the consent page uses a
  restrictive Content Security Policy.
- GitHub feature endpoints may answer `403` or `404` when a plan or permission
  is missing. Those signals become `unknown`, never a passing result.

## Scoring

Rules emit a stable ID, category, state, score impact, confidence, evidence,
and remediation. Category totals are reproducible; no language model decides a
score. `action_plan` deduplicates failures and sorts by severity, recoverable
points, confidence, and rule ID so identical evidence yields identical output.

The six MCP tools intentionally sit above GitHub's generic API surface:

- `portfolio_snapshot`
- `repo_readiness`
- `branch_risk`
- `delivery_hygiene`
- `security_posture`
- `action_plan`

## Operations

`wrangler.jsonc` is the source of truth for bindings and runtime flags.
`wrangler types` generates `worker-configuration.d.ts`; bindings are not
hand-written. Logs and traces are enabled, but tokens, OAuth props, and GitHub
response bodies are never logged.
