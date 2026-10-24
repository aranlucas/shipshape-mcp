# Central Auth migration

Shipshape is an OAuth resource server. The central Auth Worker owns GitHub
social login, account connections, consent, client registration, token issuance,
refresh, and revocation. Repository access continues through Shipshape's GitHub
App installation tokens.

## Auth contract

| Setting                    | Value                                                         |
| -------------------------- | ------------------------------------------------------------- |
| Issuer                     | `https://auth.aranlucas.workers.dev/api/auth`                 |
| Authorization              | `${issuer}/oauth2/authorize`                                  |
| Token                      | `${issuer}/oauth2/token`                                      |
| Public client registration | `${issuer}/oauth2/register`                                   |
| JWKS                       | `${issuer}/jwks`                                              |
| Shipshape resource         | `https://shipshape-mcp.aranlucas.workers.dev/mcp`             |
| Scope                      | `shipshape:access`                                            |
| Dashboard callback         | `https://shipshape-mcp.aranlucas.workers.dev/callback/web`    |
| GitHub social callback     | `https://auth.aranlucas.workers.dev/api/auth/callback/github` |

The [Auth project](https://github.com/sidequest-labs/auth) must declare this resource and
scope, permit public PKCE client registration for it, and include `github_id`
(numeric account ID encoded as a string) and `github_login` claims only after
verifying a linked GitHub account. Shipshape checks these claims after verifying
the signature, issuer, exact resource audience, `at+jwt` type, expiration and
scope. It rejects proof-bound tokens, invalid claim shapes, and non-owner IDs.
Auth's internal `sub` is a separate identifier from the numeric GitHub ID.

Better Auth's built-in GitHub social provider owns the GitHub code exchange.
Use its explicit account-link flow at
[the account page](https://auth.aranlucas.workers.dev/account); an email match
must not silently merge accounts. The GitHub connection step must preserve the
provider's signed OAuth continuation through consent.

## Rollout

1. Configure `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` on the **Auth** Worker.
   Reuse the existing GitHub App's OAuth credentials or create a dedicated login
   app. Register the GitHub social callback above. A GitHub App used for Better
   Auth also needs **Email addresses: Read-only**; installation repository
   permissions remain separate. See [Better Auth's GitHub provider](https://better-auth.com/docs/authentication/github).
2. Deploy the Auth changes, including its Shipshape resource, claims and account
   connection flow. Confirm discovery and JWKS are healthy, then link the owner
   GitHub account from `/account`.
3. Deploy Shipshape with `BETTER_AUTH_ISSUER`, `BETTER_AUTH_JWKS_URL`,
   `PUBLIC_ORIGIN`, and the existing `OWNER_GITHUB_ID`. Keep its installation
   private key, webhook secret, D1, queues and `OAUTH_KV` binding.
4. Reconnect MCP clients so discovery uses central Auth. Old Shipshape-issued
   bearer/refresh tokens stop working. Sign in to the dashboard again; old
   local sessions are discarded by the new expiration-bearing record format.
5. After validating login and MCP access, remove the unused
   `GITHUB_APP_CLIENT_SECRET` and `COOKIE_ENCRYPTION_KEY` from **Shipshape**.
   Keep Auth's credentials and Shipshape's installation/webhook credentials.

No Shipshape schema migration is required. Keep the Auth deployment compatible
with its other resource servers while adding Shipshape. A rollback to the
previous Shipshape version requires restoring its old OAuth credential/callback
configuration and signing in again.

## Dashboard and test environments

The dashboard registers a public client with an exact callback, caches its ID
in KV for one day, and uses code + S256 PKCE. Its browser cookie contains only
an opaque secret; KV stores a hash of that secret, the verified GitHub identity,
and an expiration bounded by the Auth access token. No access, refresh or GitHub
token is persisted in its session. Signing out removes the local dashboard
session. Auth account connections remain at `/account`; central Auth owns
MCP client grants and revocation.

Local and preview deployments derive their callback and resource from
`PUBLIC_ORIGIN` (or the incoming origin when unset). Declare those exact URLs
on a development Auth server and configure its issuer/JWKS bindings. Production
Auth does not automatically authorize arbitrary preview resources. Additional
MCP browser origins can be configured in the `MCP_ALLOWED_ORIGINS` JSON array.

`@better-auth/mcp`, `@better-auth/oauth-provider`, and `better-auth/oauth2`
provide maintained resource verification, challenges, and metadata; the existing
`oauth4webapi` dependency handles the dashboard authorization-code exchange.
This replaces the embedded Workers OAuth provider rather than implementing
another token server. `jose` is a direct development dependency for real signed
JWT/JWKS security fixtures.

## Deployed configuration

On 2026-10-24, Auth version `96c90b0e-8f12-4612-9481-c4589d30a1aa` and
Shipshape version `7c9c8a8b-1129-49b2-a9e2-6f7b2f4bd17e` were deployed with this
contract. Auth keeps the dedicated **Auth — GitHub** OAuth application from the
merged social sign-in release; its existing production credentials were
preserved. The recovered older Shipshape sign-in credential was not installed
over the dedicated application's credential.

Live verification passed for Auth health/discovery/JWKS, Shipshape protected
resource metadata, the unauthenticated MCP challenge, and the dashboard's public
client registration and S256 PKCE redirect. Sign in to the dashboard again and
reconnect existing MCP clients to obtain central Auth grants. No database
migration was needed for the cutover.
