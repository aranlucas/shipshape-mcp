# Task 3 report: owner-gated login for `/app` and `/mcp`

## RED/GREEN evidence

- Added `test/auth/owner.test.ts` before implementation. The first run failed because `src/auth/owner.ts` did not exist. Implemented `isOwner` with `z.coerce.number().int().positive()` and reran: 3 tests passed.
- Added tokenless session coverage before the session migration. The first run returned the previous `{ login, accessToken }` shape. Migrated the record schema and reran: 1 test passed.
- Updated OAuth and web coverage for App OAuth credentials, omitted GitHub scope, numeric identity validation, owner and non-owner callbacks, identity-only sessions, MCP rejection, placeholder rendering, same-origin sign-out, and retired endpoint 404s.

## Implementation

- Added `src/auth/owner.ts`; numeric `OWNER_GITHUB_ID` is authoritative, and invalid or non-positive configuration rejects every identity.
- Migrated GitHub OAuth to `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`; `/user` requires `{ login, id }`, and the access token is discarded after identity validation.
- Added owner gates to both web and MCP callbacks. Non-owners receive 403 with the required message; web login state is cleared and no session is created; MCP `completeAuthorization` is not called.
- Changed MCP props to `{ login, userId }` and removed access-token-based MCP context handling. Existing portfolio registrations use the Task 11 temporary throwing stub.
- Migrated web sessions to `{ login, userId, createdAt }`; retained the hashed cookie key, `__Host-shipshape-session`, and 8-hour TTL.
- Added `src/web/placeholder.ts`; authenticated `/app` and `/app/review` serve the placeholder with the existing stylesheet, masthead, sign-out form, and dashboard message. Removed web drift/rules/review API and script serving.
- Removed temporary `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` worker test bindings.
- Removed the obsolete review script test as directed by the brief.

## Validation

`pnpm check` completed successfully (exit 0):

- `cf workers types`: passed
- `tsc --noEmit`: passed
- `oxlint`: passed
- `oxfmt --check`: passed
- `vitest run`: 26 test files, 267 tests passed
- `cf deploy --dry-run`: build completed; dry-run exited successfully without deployment

No real credentials, resources, remotes, pushes, or deployments were used.

## Deviations and concerns

No unavoidable deviations. The legacy MCP registration code remains only as the brief-authorized Task 11 throwing stub. Legacy source modules for the retired scripts remain in the tree but are no longer imported or served; deleting those modules is outside Task 3's requested file scope.
