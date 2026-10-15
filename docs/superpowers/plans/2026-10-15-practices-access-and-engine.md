# Practices: Access + Catalog/Check Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Shipshape into a single-user service that reads every repository (public + private, personal + org) through a GitHub App, evaluates a git-hosted catalog of personal practices against each one, and serves the results through the `/app/api` contract and MCP.

**Architecture:** A GitHub App supplies installation tokens for all reads (and catalog-repo writes). An owner-gated login (App OAuth, `OWNER_GITHUB_ID`) protects both `/app` and `/mcp`. Practices live as YAML + files in a catalog repository; a Queue-driven evaluator runs deterministic checks per repository at its head SHA and stores results in D1. The dashboard API and MCP tools read D1.

**Tech Stack:** Cloudflare Workers (`cf` CLI 1.0 beta, `cloudflare.config.ts`), D1, Queues, cron triggers, KV, `@cloudflare/workers-oauth-provider`, `octokit`, `zod` 4, `yaml`, Vitest 5 with `@cloudflare/vitest-plugin` (node + workers projects), oxlint/oxfmt.

**Spec:** `docs/superpowers/specs/2026-10-15-personal-practices-design.md` — read it fully before Task 1. The API types are already committed in `src/api/contract.ts`; do not change their shape.

## Global Constraints

- Single user: only the GitHub user whose numeric id equals `OWNER_GITHUB_ID` may sign in to `/app` or authorize `/mcp`. Everyone else gets 403.
- No visibility filtering anywhere. Delete `PrivateRepositoryError` and every call site.
- Repository reads use installation tokens only. The user OAuth token is used once to identify the user and is never stored.
- The Worker may only issue non-GET GitHub requests against `CATALOG_REPO`. Enforce in one function (`assertCatalogWrite`) and unit-test it.
- Never infer `pass` from missing data: API errors, 403/404 on feature endpoints, truncated trees, and oversized blobs make a check `unknown`.
- State aggregation: any check `fail` → `fail`; else any `unknown` → `unknown`; else `pass`. `not_applicable` only from `appliesTo`.
- Read bounds per repository evaluation: 1 recursive tree, ≤ 64 blobs, ≤ 512 KB per blob.
- Queue name `shipshape-evaluations`, consumer max batch size 5. Cron `0 13 * * *`.
- Catalog commit message: `practice(<id>): update from dashboard` (and `practice(<id>): delete from dashboard`).
- Do not create or edit anything under `src/ui/**`. Do not restyle pages. UI is owned by another agent.
- `src/api/contract.ts` is the response contract. Endpoint handlers must return objects typed as those interfaces.
- Keep `pnpm check` green at every commit (types, typecheck, lint, format:check, test, dry-run).
- Follow repo idiom: oxfmt formatting, zod at every boundary, `@/` and `@test/` path aliases, no `any`.
- Commit after every task with a conventional-commit message. End every commit message with:
  `Co-Authored-By: Codex (gpt-6.1-sol) <noreply@openai.com>`

## Review Focus

1. **Repository with an empty default branch or no commits** (tree endpoint 409/404) → every file check is `unknown` with a detail, never a crash of the batch. Test in Task 8.
2. **Practice YAML edited in the dashboard with a typo** (e.g. `checks: - type: file-exist`) → 400 with an issue at `checks.0.type`, nothing committed; and a broken practice already in the catalog → that practice `unknown` everywhere while other practices still evaluate. Tests in Tasks 5 and 10.
3. **Webhook replay / wrong signature / non-default-branch push** → 401 for bad signatures; pushes to non-default branches enqueue nothing. Tests in Task 9.
4. **App installation removed or token exchange fails for one org** → that installation's repos become `unknown` with prior `checkedAt` kept; other installations still evaluate. Test in Task 8.
5. **Second GitHub account signs in** (e.g. a collaborator clicks the login link) → 403 page, no session cookie set; MCP authorize for the same account → 403. Tests in Task 3.

---

## File Structure

```text
cloudflare.config.ts                 MODIFY  App vars/secrets, D1, Queue producer+consumer, cron
vitest.config.ts                     MODIFY  synthetic bindings for new vars, D1 migrations
migrations/0001_practices.sql        CREATE  D1 schema
.dev.vars.example                    MODIFY  new secrets
src/env.ts                           CREATE  AppEnv interface (all bindings)
src/github/app.ts                    CREATE  App JWT, installation tokens (KV cache), installation Octokit
src/github/webhook.ts                CREATE  signature verification + event parsing
src/github/catalog-write.ts          CREATE  assertCatalogWrite + commitCatalogChange (Git Data API)
src/auth/owner.ts                    CREATE  owner gate (identify user via App OAuth, compare id)
src/oauth.ts                         MODIFY  App OAuth creds, owner gate, props {login,userId}
src/web/session.ts                   MODIFY  session stores {login,userId}, no token
src/web/routes.ts                    MODIFY  drop drift/review APIs, mount src/api/routes.ts, placeholder page
src/web/placeholder.ts               CREATE  minimal signed-in placeholder page for /app
src/inventory/sync.ts                CREATE  installations → repositories → D1
src/practices/schema.ts              CREATE  practice.yml zod schema + parsePractice
src/practices/catalog.ts             CREATE  load catalog from CATALOG_REPO at a SHA, cache in D1
src/practices/applies.ts             CREATE  appliesTo matcher
src/practices/checks.ts              CREATE  check evaluators (pure, over a RepoSnapshot)
src/practices/snapshot.ts            CREATE  bounded GitHub reads → RepoSnapshot
src/practices/evaluate.ts            CREATE  evaluateRepository: snapshot + catalog → D1 rows
src/practices/store.ts               CREATE  D1 reads/writes (results, repos, catalog, sweep)
src/queue.ts                         CREATE  queue consumer + enqueue helpers
src/scheduled.ts                     CREATE  cron handler
src/api/routes.ts                    CREATE  /app/api/* handlers per contract
src/api/contract.ts                  EXISTS  do not change shapes
src/mcp.ts                           REWRITE practices_overview, repo_practices, practice_detail
src/index.ts                         MODIFY  export { fetch, queue, scheduled }, /github/webhook
catalog-seed/practices/**            CREATE  8 seed practices
docs/setup.md                        CREATE  App creation + resource setup
README.md, docs/architecture.md      MODIFY  describe the new product
DELETE: src/domain/**, src/review/**, src/github/portfolio.ts, src/github/private-repository-error.ts,
        src/standards/** (except lint-config.ts + config-value.ts, moved under src/practices/),
        src/web/page.ts, src/web/script.ts, src/web/review-page.ts, src/web/review-script.ts,
        docs/settings-drift.md, docs/repository-review.md, docs/standards.md, .shipshape.yml,
        and tests that only cover deleted code.
```

`src/drift/collect.ts` and `src/drift/evaluate.ts` hold reusable logic (branch protection reading, workflow inspection). Task 7 extracts what checks need into `src/practices/snapshot.ts` / `checks.ts`; Task 12 deletes the rest of `src/drift/`.

---

### Task 1: Bindings, D1 schema, AppEnv

**Files:**

- Modify: `cloudflare.config.ts`, `vitest.config.ts`, `.dev.vars.example`
- Create: `migrations/0001_practices.sql`, `src/env.ts`
- Test: `test/workers/d1-schema.test.ts`

**Interfaces:**

- Produces: `AppEnv` (in `src/env.ts`):

```ts
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { OAuthStateStore } from "./oauth-security";

export interface EvaluationMessage {
  repo: string; // "owner/name"
  installationId: number;
  reason: "push" | "catalog" | "sweep" | "manual" | "installation";
}

export interface AppEnv {
  OAUTH_KV: OAuthStateStore & KVNamespace;
  OAUTH_PROVIDER: Pick<OAuthHelpers, "parseAuthRequest" | "lookupClient" | "completeAuthorization">;
  DB: D1Database;
  EVALUATIONS: Queue<EvaluationMessage>;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_CLIENT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  OWNER_GITHUB_ID: string;
  CATALOG_REPO: string;
  COOKIE_ENCRYPTION_KEY?: string;
  GITHUB_API_VERSION?: string;
  PUBLIC_ORIGIN?: string;
}
```

- [ ] **Step 1: Write `migrations/0001_practices.sql`**

```sql
CREATE TABLE repositories (
  full_name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  private INTEGER NOT NULL,
  archived INTEGER NOT NULL,
  fork INTEGER NOT NULL,
  language TEXT,
  default_branch TEXT NOT NULL,
  pushed_at TEXT,
  html_url TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE TABLE catalog (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  repo TEXT NOT NULL,
  sha TEXT,
  loaded_at TEXT,
  practices_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE results (
  repo_full_name TEXT NOT NULL,
  practice_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pass','fail','unknown','not_applicable')),
  failing INTEGER NOT NULL DEFAULT 0,
  unknown INTEGER NOT NULL DEFAULT 0,
  checks_json TEXT NOT NULL DEFAULT '[]',
  head_sha TEXT,
  catalog_sha TEXT,
  checked_at TEXT,
  PRIMARY KEY (repo_full_name, practice_id)
);

CREATE INDEX results_by_practice ON results (practice_id, state);

CREATE TABLE sweep (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_completed_at TEXT,
  pending INTEGER NOT NULL DEFAULT 0
);

INSERT INTO sweep (id, pending) VALUES (1, 0);
```

- [ ] **Step 2: Update `cloudflare.config.ts`**

Import `triggers` alongside `bindings` from `"cf/config"`. Keep existing observability, `GITHUB_API_VERSION`, `PUBLIC_ORIGIN`, `COOKIE_ENCRYPTION_KEY`, `OAUTH_KV`. Remove `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`. Add:

```ts
GITHUB_APP_ID: bindings.text(process.env.GITHUB_APP_ID ?? "0"),
GITHUB_APP_CLIENT_ID: bindings.text(process.env.GITHUB_APP_CLIENT_ID ?? "unset"),
OWNER_GITHUB_ID: bindings.text(process.env.OWNER_GITHUB_ID ?? "0"),
CATALOG_REPO: bindings.text("aranlucas/practices"),
GITHUB_APP_PRIVATE_KEY: bindings.secret(),
GITHUB_APP_CLIENT_SECRET: bindings.secret(),
GITHUB_WEBHOOK_SECRET: bindings.secret(),
DB: bindings.d1({ /* name/id: use the option names from @cloudflare/config D1BindingOptions; database name "shipshape" */ }),
EVALUATIONS: bindings.queue({ /* producer for queue "shipshape-evaluations" — check QueueBinding options */ }),
```

and on `worker`:

```ts
triggers: [
  triggers.queue({ name: "shipshape-evaluations", maxBatchSize: 5 }),
  triggers.scheduled({ schedule: "0 13 * * *" }),
],
```

Exact option names come from `node_modules/.pnpm/@cloudflare+config@0.18.0/node_modules/@cloudflare/config/dist/public-*.d.mts` (`D1BindingOptions`, `QueueBinding` options, `QueueConsumerTriggerOptions`). Read those types; do not guess. Point D1 at `migrations/` if the options support a migrations directory. The real D1 id is filled in during setup (Task 13 docs); use the option that lets `cf` provision/resolve by name if available.

- [ ] **Step 3: Run `pnpm types`** and confirm `.cloudflare/types/index.d.ts` now declares `DB`, `EVALUATIONS`, and the new vars.

- [ ] **Step 4: Update `vitest.config.ts` workers project**

Replace the synthetic bindings with:

```ts
bindings: {
  GITHUB_APP_ID: "12345",
  GITHUB_APP_CLIENT_ID: "Iv1.synthetic",
  GITHUB_APP_CLIENT_SECRET: "synthetic-secret",
  GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
  GITHUB_WEBHOOK_SECRET: "synthetic-webhook-secret",
  OWNER_GITHUB_ID: "1001",
  CATALOG_REPO: "aranlucas/practices",
  COOKIE_ENCRYPTION_KEY: "synthetic-cookie-key",
},
```

Generate `TEST_PRIVATE_KEY_PEM` once (`openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048`) and store it in `test/helpers/app-key.ts` as an exported string constant (`export const TEST_PRIVATE_KEY_PEM = \`-----BEGIN PRIVATE KEY-----...\``) — test-only key, add a comment saying so. Note the CI "Reject tracked credentials" step greps for `BEGIN (RSA|OPENSSH|EC|PGP) PRIVATE KEY`; PKCS#8 `BEGIN PRIVATE KEY`does not match, keep it PKCS#8. Load D1 migrations for tests with`readD1Migrations("./migrations")`from`@cloudflare/vitest-plugin`and pass them as a`TEST_MIGRATIONS` binding, then apply them in a setup file (`test/workers/setup.ts`) using `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)`from`cloudflare:test`. Register the setup file in the workers project `setupFiles`.

- [ ] **Step 5: Update `.dev.vars.example`**

```text
# Copy to .dev.vars for local development. Never commit real credentials.
GITHUB_APP_ID=""
GITHUB_APP_CLIENT_ID=""
GITHUB_APP_CLIENT_SECRET=""
# PKCS#8 PEM, newlines as \n. Convert GitHub's key: openssl pkcs8 -topk8 -nocrypt -in app.pem
GITHUB_APP_PRIVATE_KEY=""
GITHUB_WEBHOOK_SECRET=""
OWNER_GITHUB_ID=""
COOKIE_ENCRYPTION_KEY="generate-with-openssl-rand-32"
```

- [ ] **Step 6: Write the failing test `test/workers/d1-schema.test.ts`**

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("D1 schema", () => {
  it("creates the practice tables and the sweep row", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const names = tables.results.map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining(["catalog", "repositories", "results", "sweep"]));
    const sweep = await env.DB.prepare("SELECT pending FROM sweep WHERE id = 1").first<{
      pending: number;
    }>();
    expect(sweep?.pending).toBe(0);
  });
});
```

- [ ] **Step 7: Run** `pnpm vitest run --project workers test/workers/d1-schema.test.ts` → PASS (it fails before Step 4's migration wiring).

- [ ] **Step 8: Add `src/env.ts`** (code above). Run `pnpm typecheck` → PASS.

- [ ] **Step 9: Commit** `chore: add GitHub App, D1, queue, and cron bindings`

---

### Task 2: GitHub App tokens and webhook verification

**Files:**

- Create: `src/github/app.ts`, `src/github/webhook.ts`
- Test: `test/github/app.test.ts`, `test/github/webhook.test.ts`

**Interfaces:**

- Consumes: `AppEnv` (Task 1), `createGitHubOctokit(token, apiVersion?, options?)` from `src/github/client.ts`.
- Produces:

```ts
// src/github/app.ts
export async function createAppJwt(
  appId: string,
  pkcs8Pem: string,
  nowSeconds?: number,
): Promise<string>;
export async function installationToken(env: AppEnv, installationId: number): Promise<string>;
export async function installationClient(
  env: AppEnv,
  installationId: number,
): Promise<GitHubOctokit>;
export async function appClient(env: AppEnv): Promise<GitHubOctokit>; // authenticated with the App JWT
// src/github/webhook.ts
export async function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string | null,
): Promise<boolean>;
```

- [ ] **Step 1: Failing tests for `createAppJwt`** (`test/github/app.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { createAppJwt } from "@/github/app";
import { TEST_PRIVATE_KEY_PEM, TEST_PUBLIC_KEY_PEM } from "@test/helpers/app-key";

function decode(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("createAppJwt", () => {
  it("signs an RS256 JWT GitHub accepts (iss, iat backdated 60s, exp ≤ 10 min)", async () => {
    const jwt = await createAppJwt("12345", TEST_PRIVATE_KEY_PEM, 1_800_000_000);
    const [header, payload, signature] = jwt.split(".");
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(payload)).toEqual({ iss: "12345", iat: 1_799_999_940, exp: 1_800_000_540 });
    const key = await crypto.subtle.importKey(
      "spki",
      Buffer.from(TEST_PUBLIC_KEY_PEM.replace(/-----[^-]+-----|\s/g, ""), "base64"),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      Buffer.from(signature, "base64url"),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(ok).toBe(true);
  });

  it("rejects a PKCS#1 key with a message pointing at the conversion command", async () => {
    await expect(
      createAppJwt("1", "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----"),
    ).rejects.toThrow(/openssl pkcs8 -topk8/);
  });
});
```

Add `TEST_PUBLIC_KEY_PEM` (SPKI) to `test/helpers/app-key.ts`.

Note: the PKCS#1 test literal contains `BEGIN RSA PRIVATE KEY`, which the CI credential grep rejects. Build it at runtime instead: `` `-----BEGIN ${"RSA"} PRIVATE KEY-----` ``.

- [ ] **Step 2: Run** `pnpm vitest run test/github/app.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `createAppJwt`**

```ts
const encoder = new TextEncoder();

function base64Url(bytes: ArrayBuffer | Uint8Array | string): string {
  const view = typeof bytes === "string" ? encoder.encode(bytes) : new Uint8Array(bytes);
  return btoa(String.fromCodePoint(...view))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export async function createAppJwt(
  appId: string,
  pkcs8Pem: string,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  if (pkcs8Pem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY must be PKCS#8. Convert it with: openssl pkcs8 -topk8 -nocrypt -in app.pem",
    );
  }
  const der = Uint8Array.from(
    atob(pkcs8Pem.replace(/-----[^-]+-----|\\n|\s/gu, "")),
    (c) => c.codePointAt(0) ?? 0,
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ iss: appId, iat: nowSeconds - 60, exp: nowSeconds + 540 }),
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64Url(signature)}`;
}
```

(The `\\n` handles keys stored with literal `\n` in `.dev.vars`.)

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Failing tests for `installationToken` caching** (same file; mock `fetch` with `vi.spyOn(globalThis, "fetch")` like `test/workers/oauth-provider.test.ts` does, and a fake KV `Map`-backed object with `get/put/delete`):
  - first call POSTs `https://api.github.com/app/installations/42/access_tokens` with `Authorization: Bearer <jwt>` and returns the token; KV `put` called with key `app:installation-token:42` and `expirationTtl` = seconds until `expires_at` minus 300.
  - second call within TTL returns the cached token without fetch.
  - a 404 from GitHub throws `InstallationUnavailableError` (export it) carrying `installationId`.

- [ ] **Step 6: Implement** `installationToken`, `installationClient` (wrap `createGitHubOctokit(token, env.GITHUB_API_VERSION)`), `appClient` (Octokit with `auth` = JWT), and `InstallationUnavailableError`. Validate the token response with zod `{ token: z.string(), expires_at: z.iso.datetime() }`. Run → PASS.

- [ ] **Step 7: Failing tests for `verifyWebhookSignature`** (`test/github/webhook.test.ts`): valid `sha256=<hex hmac>` → true; wrong secret → false; missing header → false; `sha1=` prefix → false; header of different length → false (no throw).

- [ ] **Step 8: Implement** with `crypto.subtle.importKey("raw", secret, {name:"HMAC", hash:"SHA-256"})`, hex-encode, compare with the existing `constantTimeEqual` from `src/oauth-security.ts`. Run → PASS.

- [ ] **Step 9: Commit** `feat: sign GitHub App JWTs and verify webhook signatures`

---

### Task 3: Owner-gated login for /app and /mcp

**Files:**

- Create: `src/auth/owner.ts`
- Modify: `src/oauth.ts`, `src/web/session.ts`, `src/web/routes.ts`, `src/config.ts`, `src/index.ts`
- Create: `src/web/placeholder.ts`
- Test: `test/auth/owner.test.ts`, update `test/oauth.test.ts`, `test/web.test.ts`, `test/workers/oauth-provider.test.ts`

**Interfaces:**

- Produces:

```ts
// src/auth/owner.ts
export interface OwnerIdentity {
  login: string;
  userId: number;
}
export function isOwner(env: Pick<AppEnv, "OWNER_GITHUB_ID">, identity: OwnerIdentity): boolean;
// src/web/session.ts (changed)
export interface WebSession {
  readonly login: string;
  readonly userId: number;
}
export async function createSession(kv: OAuthStateStore, session: WebSession): Promise<string>;
export async function readSession(
  kv: OAuthStateStore,
  request: Request,
): Promise<WebSession | null>;
// MCP grant props
type McpProps = { login: string; userId: number };
```

Behavior:

- `GITHUB_SCOPE` becomes `""` (GitHub App OAuth ignores scopes; omit the `scope` param when empty).
- `completeGitHubLogin` uses `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET`, fetches `/user`, validates `{ login, id }`, returns `OwnerIdentity`. The user access token is discarded after this call.
- Web callback: not owner → 403 HTML (`renderSignInPage("This Shipshape instance belongs to another GitHub account.")`), no session cookie, login-state cookie cleared.
- MCP authorize callback: not owner → 403 (same message), `completeAuthorization` not called. Owner → props `{ login, userId }`.
- `src/index.ts` `githubClient()` is removed; MCP tools get an `AppEnv` instead (Task 11 wires it). Until Task 11, keep the old tool registrations compiling by passing a function that throws `GitHubInputError("Re-implemented in Task 11")` — this is the only temporary stub allowed and Task 11 deletes it.
- Session no longer stores a token: drop `iv`/`token` from `SessionRecordSchema`; store `{ login, userId, createdAt }` under the hashed key. Keep the 8h TTL, `__Host-` cookie, and hashing.
- `/app` and `/app/review` for a signed-in owner serve `renderPlaceholderPage(login)` from `src/web/placeholder.ts`: same `HEAD` styles, masthead, sign-out form, and one paragraph "The new dashboard is being built. Practice results are available at /app/api/overview." Delete `/app/api/drift`, `/app/api/rules`, `/app/api/review/*` handlers and `APP_SCRIPT`/`REVIEW_SCRIPT` serving.

- [ ] **Step 1: Failing unit tests `test/auth/owner.test.ts`**: `isOwner({OWNER_GITHUB_ID:"1001"}, {login:"aranlucas", userId:1001})` → true; userId 1002 → false; `OWNER_GITHUB_ID: "0"` or `""` → false for everyone (unconfigured instance locks everyone out); login match with different id → false (ids, not logins, are authoritative).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `isOwner` (parse with `z.coerce.number().int().positive()`; on parse failure return false). **Step 4: Run** → PASS.
- [ ] **Step 5: Update `test/web.test.ts` and `test/oauth.test.ts`** to the new behavior. Add these cases:
  - web callback with a GitHub `/user` fixture `{ login: "someone", id: 2002 }` → status 403, no `Set-Cookie` for `__Host-shipshape-session`.
  - web callback with `{ login: "aranlucas", id: 1001 }` → 302 to `/app` with a session cookie; `readSession` returns `{ login: "aranlucas", userId: 1001 }`.
  - the token exchange request uses `client_id=Iv1.synthetic`.
  - MCP authorize callback for id 2002 → 403 and `completeAuthorization` not invoked (spy on the `OAUTH_PROVIDER` helper the tests already inject).
  - signed-in `GET /app` contains "The new dashboard is being built".
  - `POST /app/api/drift` → 404.
- [ ] **Step 6: Run** → FAIL. **Step 7: Implement** the changes above. **Step 8: Run** `pnpm test` → PASS (delete test files that only exercised removed drift/review web endpoints: `test/review/script.test.ts`; keep collector tests until Task 12).
- [ ] **Step 9: Commit** `feat: gate dashboard and MCP sign-in to the owner's GitHub account`

---

### Task 4: Repository inventory

**Files:**

- Create: `src/inventory/sync.ts`, `src/practices/store.ts` (repositories part)
- Test: `test/workers/inventory.test.ts`

**Interfaces:**

- Consumes: `appClient`, `installationClient` (Task 2), `AppEnv.DB`.
- Produces:

```ts
// src/practices/store.ts
export interface StoredRepository extends RepoSummary {
  installationId: number;
}
export async function upsertRepositories(
  db: D1Database,
  repos: StoredRepository[],
  syncedAt: string,
): Promise<void>;
export async function deleteRepositoriesNotIn(
  db: D1Database,
  installationId: number,
  keep: string[],
): Promise<void>;
export async function listRepositories(db: D1Database): Promise<StoredRepository[]>;
export async function getRepository(
  db: D1Database,
  fullName: string,
): Promise<StoredRepository | null>;
// src/inventory/sync.ts
export async function syncInventory(env: AppEnv): Promise<StoredRepository[]>;
```

(`RepoSummary` is imported from `src/api/contract.ts`.)

- [ ] **Step 1: Failing test** — mock fetch: `GET /app/installations` → two installations (ids 1 `aranlucas` User, 2 `sidequest-labs` Organization); `POST /app/installations/{id}/access_tokens` → tokens; `GET /installation/repositories?per_page=100&page=1` per installation → repos including one `private: true`, one `archived: true`, one `fork: true`, and for installation 2 a `Link: <...page=2>; rel="next"` header with page 2 returning one more repo. Assert: `syncInventory` returns all repos (private included), D1 `repositories` has them with correct `installation_id`, `private` stored as 1. Second run where installation 1 no longer lists repo X → X deleted from D1 (and its `results` rows deleted).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** using `octokitPaginate` from `src/github/client.ts` with `{ maxPages: 20, perPage: 100 }` and a zod schema for `/installation/repositories` (`{ total_count, repositories: GitHubRepositorySchema.array() }`). Use `env.DB.batch()` for upserts. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: sync repository inventory from GitHub App installations`

---

### Task 5: Practice schema

**Files:**

- Create: `src/practices/schema.ts`
- Test: `test/practices/schema.test.ts`

**Interfaces:**

- Produces:

```ts
export const CheckSchema: z.ZodDiscriminatedUnion<...>; // on "type"
export type Check = z.infer<typeof CheckSchema>;
export const PracticeSchema: z.ZodObject<...>;
export type Practice = z.infer<typeof PracticeSchema>;
export interface PracticeIssue { path: string; message: string }
export type ParsedPractice =
  | { ok: true; practice: Practice }
  | { ok: false; id: string | null; issues: PracticeIssue[] };
export function parsePractice(yamlText: string, expectedId?: string): ParsedPractice;
export function checkLabel(check: Check): string;
```

- [ ] **Step 1: Failing tests** covering:
  - each seed example from the spec's `practice.yml` block parses (paste that block as a fixture, `version: 1`, all 10 check types).
  - `type: file-exist` → `{ ok: false, issues: [{ path: "checks.0.type", ... }] }`.
  - unknown top-level key → issue at that key (strict).
  - `id` not kebab-case (`Husky_Lint`) → issue at `id`.
  - `expectedId` mismatch (folder `husky` but `id: other`) → issue at `id` with message `id must match its folder name "husky"`.
  - `json-path` with neither `equals` nor `exists` → issue at `checks.N`.
  - `file-matches` `source` must start with `files/` and not contain `..` → issue at `checks.N.source`.
  - invalid YAML syntax → single issue at path `""` with message starting `Invalid YAML`.
  - `kind: settings` with a `file-exists` check → issue at `checks.N` (`settings practices may only use setting and branch-protection checks`).
  - `checkLabel` produces e.g. `".husky/pre-commit exists"`, `"package.json scripts.prepare = husky"`, `"@aranlucas/oxforge declared at 0.2.2"`, `"allow_squash_merge = true"`, `"Actions pinned to full commit SHAs"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Schema:

```ts
const RepoPath = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (p) => !p.startsWith("/") && !p.split("/").includes(".."),
    "Use a repository-relative path without ..",
  );
const Scalar = z.union([z.string(), z.number(), z.boolean()]);

export const CheckSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("file-exists"), path: RepoPath, absent: z.boolean().default(false) })
    .strict(),
  z
    .object({
      type: z.literal("file-matches"),
      path: RepoPath,
      source: RepoPath.refine((s) => s.startsWith("files/"), "source must point inside files/"),
    })
    .strict(),
  z
    .object({ type: z.literal("file-contains"), path: RepoPath, text: z.string().min(1).max(500) })
    .strict(),
  z
    .object({
      type: z.literal("json-path"),
      file: RepoPath,
      path: z.string().min(1).max(200),
      equals: Scalar.optional(),
      exists: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("yaml-path"),
      file: RepoPath,
      path: z.string().min(1).max(200),
      equals: Scalar.optional(),
      exists: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("dependency"),
      file: RepoPath.default("package.json"),
      name: z.string().min(1).max(214),
      version: z.string().min(1).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("setting"),
      key: z.string().regex(/^[a-z_]+(\.[a-z_]+)*$/u),
      equals: Scalar,
    })
    .strict(),
  z
    .object({
      type: z.literal("branch-protection"),
      key: z.enum(BRANCH_PROTECTION_KEYS),
      equals: z.boolean(),
      branch: z.string().max(255).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("workflow"),
      check: z.enum(["least-privilege-token", "pinned-actions", "dependency-review"]),
    })
    .strict(),
]);
```

`BRANCH_PROTECTION_KEYS` = the branch-protection setting ids already defined in `src/drift/policy.ts` (`enforceAdmins`, `requiredConversationResolution`, `requiredLinearHistory`, `requiredSignatures`, `allowForcePushes`, `allowDeletions`, `requireCodeOwnerReviews`, `requireLastPushApproval`, …) — import the list rather than retyping it; move it into `src/practices/schema.ts` in Task 12 when `src/drift` is deleted. `json-path`/`yaml-path` refine: exactly one of `equals`/`exists`. `PracticeSchema` = `{ version: z.literal(1), id: kebab regex /^[a-z0-9]+(-[a-z0-9]+)*$/ max 64, title: 1..80, summary: 1..200, kind: z.enum(["files","settings"]), appliesTo: AppliesToSchema.default({}), checks: z.array(CheckSchema).min(1).max(40) }` strict, plus the kind/check-type superRefine. `AppliesToSchema` = `{ owners?: string[], languages?: string[], hasFiles?: RepoPath[], include?: string[] (default ["*"]), exclude?: string[] (default []), archived: boolean default false, forks: boolean default false }` strict. Parse YAML with `parseDocument(text, { uniqueKeys: true })` like `src/standards/policy.ts` does. Map zod issues to `{ path: issue.path.join("."), message }`.

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat: define the practice.yml schema`

---

### Task 6: Catalog loading

**Files:**

- Create: `src/practices/catalog.ts`; extend `src/practices/store.ts`
- Test: `test/workers/catalog.test.ts`

**Interfaces:**

- Consumes: `parsePractice` (Task 5), `installationClient` (Task 2), `getRepository` (Task 4).
- Produces:

```ts
export interface CatalogPractice {
  id: string;
  folder: string;
  yaml: string;
  instructions: string | null;
  files: Record<string, string>; // "files/.husky/pre-commit" → content
  parsed: ParsedPractice;
}
export interface Catalog {
  repo: string;
  sha: string;
  practices: CatalogPractice[];
}
export async function loadCatalog(env: AppEnv): Promise<Catalog>; // fetch from GitHub at default-branch head, persist to D1
export async function readStoredCatalog(db: D1Database): Promise<Catalog | null>;
export function practiceSummary(p: CatalogPractice): PracticeSummary; // contract type
```

- [ ] **Step 1: Failing test** — catalog repo `aranlucas/practices` is in `repositories` (installation 1). Mock: `GET /repos/aranlucas/practices` (default_branch main), `GET /repos/aranlucas/practices/commits/main` (sha `c0ffee…40 hex`), recursive tree with `practices/husky/practice.yml`, `practices/husky/instructions.md`, `practices/husky/files/.husky/pre-commit`, `practices/broken/practice.yml`, and `README.md`; blobs for each. Assert `loadCatalog` returns 2 practices sorted by id; `husky` parsed ok with its file and instructions; `broken` has `parsed.ok === false` and `practiceSummary` gives `valid: false, error: "<first issue path>: <message>"`; D1 `catalog` row has the sha and `practices_json`; `readStoredCatalog` round-trips. Also: catalog repo not in inventory → throws `CatalogUnavailableError` with message `Install the Shipshape GitHub App on aranlucas/practices`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Only read blobs under `practices/<folder>/` (`practice.yml`, `instructions.md`, `files/**`), bounded by 200 blobs × 256 KB; decode base64 blob content with `TextDecoder`. Folder name = second path segment; pass it as `expectedId`. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: load the practice catalog from its repository`

---

### Task 7: Repository snapshot and check evaluators

**Files:**

- Create: `src/practices/snapshot.ts`, `src/practices/checks.ts`, `src/practices/applies.ts`
- Move: workflow inspection helpers from `src/drift/evaluate.ts` (least-privilege token, SHA pinning, dependency review) into `src/practices/workflows.ts` unchanged, re-export from the old location until Task 12.
- Test: `test/practices/checks.test.ts`, `test/practices/applies.test.ts`

**Interfaces:**

- Consumes: `Check`, `Practice` (Task 5), `CheckResult`, `CellResult`, `PracticeState` (contract).
- Produces:

```ts
// snapshot.ts
export interface RepoSnapshot {
  repo: StoredRepository;
  headSha: string | null;
  tree: { paths: Set<string>; truncated: boolean } | null; // null = unreadable
  treeError: string | null;
  files: Map<string, string | { error: string }>; // only files checks need
  settings: Record<string, unknown> | { error: string } | null; // GET /repos/{o}/{r} body; null = not needed
  protection: Map<string, BranchProtectionFact>; // branch → fact (reuse drift type)
}
export function filesNeeded(practices: Practice[]): string[]; // paths from file-matches/contains/json-path/yaml-path/dependency + workflow files marker
export async function takeSnapshot(
  client: GitHubOctokit,
  repo: StoredRepository,
  practices: Practice[],
): Promise<RepoSnapshot>;
// applies.ts
export function applies(
  practice: Practice,
  repo: StoredRepository,
  snapshot: Pick<RepoSnapshot, "tree">,
): boolean | "unknown";
// checks.ts
export function runCheck(
  check: Check,
  snapshot: RepoSnapshot,
  practiceFiles: Record<string, string>,
): CheckResult;
export function aggregate(results: CheckResult[]): {
  state: Exclude<PracticeState, "not_applicable">;
  failing: number;
  unknown: number;
};
```

Rules (each gets a pass, fail, and unknown test case where an unknown exists):

| type              | pass                                                                                        | fail                                    | unknown                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------- |
| file-exists       | path in tree (or absent in tree when `absent`)                                              | opposite                                | tree null or truncated and path missing                                    |
| file-matches      | normalized content equal (CRLF→LF, strip trailing spaces per line, single trailing newline) | differs or file missing (tree complete) | read error, source missing from practice files                             |
| file-contains     | substring present                                                                           | absent or file missing                  | read error                                                                 |
| json-path         | value at dot path `===` equals / exists                                                     | differs / missing                       | file unreadable, JSON parse error                                          |
| yaml-path         | same, YAML parse                                                                            | same                                    | same                                                                       |
| dependency        | exact string in any of dependencies/devDependencies/optionalDependencies/peerDependencies   | different exact version or missing      | non-exact range (`^`, `~`, `catalog:`, `workspace:`) → unknown with detail |
| setting           | dot-path value in `settings` equals                                                         | differs                                 | settings error, or value `undefined` (hidden)                              |
| branch-protection | reuse drift `protectionState` semantics on default branch (or `branch`)                     |                                         | fact status unknown                                                        |
| workflow          | helper returns pass for every `.github/workflows/*.y{a,}ml`                                 | any fails                               | tree unreadable or a workflow unreadable                                   |

`expected`/`actual` are stringified (`JSON.stringify` for non-strings, `null` when not applicable). `detail` explains unknowns (e.g. `"GET /repos/o/r returned 403"`).

`applies`: owners (case-insensitive), languages (exact GitHub name), include/exclude via the existing glob matcher in `src/drift/policy.ts` (`ruleSelects` logic — extract the glob function), archived/forks flags, `hasFiles` → needs tree: tree null → `"unknown"`.

- [ ] **Step 1: Failing tests** — one `describe` per check type with the table's cases, built from an in-memory `RepoSnapshot` factory in `test/helpers/snapshot.ts` (`makeSnapshot({ paths?, files?, settings?, truncated?, protection? })`). Plus `aggregate`: `[pass, unknown, fail]` → fail (1 failing, 1 unknown); `[pass, unknown]` → unknown; `[]` → pass is impossible because schema requires ≥1 check, still return pass. Plus `applies` cases: language mismatch → false; `hasFiles` missing with complete tree → false; with null tree → "unknown"; archived repo with default `archived: false` → false.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `applies.ts`, `checks.ts`.
- [ ] **Step 4: Failing tests for `takeSnapshot`** (fetch mock): reads `GET /repos/{o}/{r}` only when a setting check exists; reads branch protection only when a branch-protection check exists; tree via `GET /repos/{o}/{r}/git/trees/{default_branch}?recursive=1`; tree 409 (empty repo) → `tree: null, treeError: "Repository has no commits"`; more than 64 needed files → files beyond 64 recorded as `{ error: "Read budget exceeded" }`; blob over 512 KB (contents API `size`) → `{ error: "File larger than 512 KB" }`. Use `GET /repos/{o}/{r}/contents/{path}?ref={headSha}` for files; `headSha` from `GET /repos/{o}/{r}/commits/{default_branch}`.
- [ ] **Step 5: Implement `takeSnapshot`**, with `pLimit(MAX_ALLOWED_CONCURRENCY)` for file reads. **Step 6: Run** → PASS.
- [ ] **Step 7: Commit** `feat: evaluate practice checks against repository snapshots`

---

### Task 8: Evaluate a repository end to end

**Files:**

- Create: `src/practices/evaluate.ts`; extend `src/practices/store.ts`
- Test: `test/workers/evaluate.test.ts`

**Interfaces:**

- Consumes: Tasks 4–7.
- Produces:

```ts
// store.ts
export interface StoredResult {
  repo: string;
  practiceId: string;
  cell: CellResult;
  checks: CheckResult[];
  headSha: string | null;
  catalogSha: string | null;
}
export async function writeResults(db: D1Database, rows: StoredResult[]): Promise<void>;
export async function readResults(db: D1Database, repo?: string): Promise<StoredResult[]>;
export async function lastEvaluation(
  db: D1Database,
  repo: string,
): Promise<{ headSha: string | null; catalogSha: string | null } | null>;
export async function markUnknown(
  db: D1Database,
  repo: string,
  catalog: Catalog,
  detail: string,
): Promise<void>; // keeps prior checked_at
// evaluate.ts
export async function evaluateRepository(
  env: AppEnv,
  fullName: string,
  options?: { force?: boolean },
): Promise<"evaluated" | "skipped" | "unavailable">;
```

Flow: read stored catalog (load if missing) → repo from D1 → installation client (`InstallationUnavailableError` → `markUnknown(..., "GitHub App installation unavailable")`, return `"unavailable"`) → fetch head sha → skip if `{headSha, catalogSha}` equals `lastEvaluation` and not `force` → `takeSnapshot` with valid practices → for each catalog practice: invalid → unknown row with `checks: []` and detail; `applies` false → `not_applicable`; `"unknown"` → unknown; else run checks + aggregate → `writeResults` (one batch) → also delete result rows for practice ids no longer in the catalog.

- [ ] **Step 1: Failing tests** (fetch-mocked GitHub + real D1):
  - happy path: 3 practices (one passing, one failing, one not applicable by language) → 3 rows with correct states and `checked_at` set.
  - second call with same head sha and catalog sha → `"skipped"`, zero GitHub calls after the head-sha read.
  - `force: true` → re-evaluated.
  - installation token 404 → `"unavailable"`, existing rows become `unknown` with their old `checked_at` preserved.
  - empty repo (tree 409) → file practices `unknown` with detail, settings practices still evaluated.
  - catalog has an invalid practice → that practice row `unknown`, others evaluated.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: evaluate repositories and store practice results`

---

### Task 9: Queue consumer, cron, and webhooks

**Files:**

- Create: `src/queue.ts`, `src/scheduled.ts`
- Modify: `src/index.ts`, `src/practices/store.ts` (sweep counters)
- Test: `test/workers/webhook.test.ts`, `test/workers/queue.test.ts`

**Interfaces:**

- Produces:

```ts
// queue.ts
export async function enqueueRepositories(
  env: AppEnv,
  repos: StoredRepository[],
  reason: EvaluationMessage["reason"],
): Promise<number>;
export async function handleQueue(
  batch: MessageBatch<EvaluationMessage>,
  env: AppEnv,
): Promise<void>;
// scheduled.ts
export async function handleScheduled(env: AppEnv): Promise<void>; // syncInventory → loadCatalog → enqueue all ("sweep")
// index.ts default export: { fetch, queue: handleQueue, scheduled: (c, env, ctx) => ctx.waitUntil(handleScheduled(env)) }
```

`POST /github/webhook` (handled before the OAuth provider in `index.ts` `fetch`):

- read raw body (≤ 5 MB, else 413), verify signature → 401 on failure.
- `X-GitHub-Event: ping` → 200.
- `push`: parse `{ ref, repository: { full_name, default_branch }, installation: { id } }`. Ignore unless `ref === "refs/heads/" + default_branch`. If `full_name` equals `CATALOG_REPO` (case-insensitive) → `loadCatalog` then enqueue all repos with reason `catalog`; else enqueue that repo (`push`). → 202.
- `installation`, `installation_repositories`, `repository` → `syncInventory` then enqueue new/changed repos (`installation`). → 202.
- anything else → 204.
- Use `ctx.waitUntil` for the work after responding 202.

`handleQueue`: for each message `evaluateRepository(env, msg.body.repo, { force: msg.body.reason === "manual" || msg.body.reason === "catalog" })`, `msg.ack()` on success, `msg.retry({ delaySeconds: 60 })` on thrown errors. Sweep bookkeeping: `enqueueRepositories` increments `sweep.pending` by count; each processed message decrements; when it reaches 0 set `last_completed_at`.

- [ ] **Step 1: Failing webhook tests** (via `exports.default.fetch` / `SELF` like `test/workers/oauth-provider.test.ts`): bad signature → 401 and no queue send (spy `env.EVALUATIONS.send`/`sendBatch`); push to `refs/heads/feature` → 202 and nothing enqueued; push to default branch → one message `{ repo, installationId, reason: "push" }`; push to catalog repo → catalog reloaded + every repo enqueued with `reason: "catalog"`; `ping` → 200.
- [ ] **Step 2: Failing queue tests**: a batch of 2 messages → both evaluated and acked; evaluation throws → `retry` called; sweep pending goes 2 → 0 and `last_completed_at` set.
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement.** **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `feat: drive evaluations from webhooks, queue, and a daily sweep`

---

### Task 10: Dashboard API (`/app/api/*`)

**Files:**

- Create: `src/api/routes.ts`, `src/github/catalog-write.ts`
- Modify: `src/web/routes.ts` (delegate `/app/api/*` to `apiHandler`)
- Test: `test/workers/api.test.ts`, `test/github/catalog-write.test.ts`

**Interfaces:**

- Consumes: store functions, `readStoredCatalog`, `practiceSummary`, `parsePractice`, `enqueueRepositories`, contract types.
- Produces:

```ts
// catalog-write.ts
export function assertCatalogWrite(
  env: Pick<AppEnv, "CATALOG_REPO">,
  owner: string,
  repo: string,
): void; // throws CatalogWriteRefusedError
export interface CatalogChange {
  practiceId: string;
  delete?: boolean;
  yaml?: string;
  instructions?: string | null;
  files?: Array<{ path: string; content: string }>;
}
export async function commitCatalogChange(env: AppEnv, change: CatalogChange): Promise<string>; // returns new commit sha
// api/routes.ts
export async function apiHandler(
  request: Request,
  env: AppEnv,
  session: WebSession,
  ctx: ExecutionContext,
): Promise<Response>;
```

Endpoints (all return contract types; errors are `ApiErrorResponse`):

- `GET /app/api/overview` → `OverviewResponse`. `results` includes a `CellResult` for every (repo, practice) pair present in D1; missing pairs are omitted (UI treats as never evaluated). Repos sorted by `fullName`, practices by `id`.
- `GET /app/api/repos/:owner/:name` → `RepoDetailResponse` (404 `{ error: "Repository not found" }`).
- `GET /app/api/practices/:id` → `PracticeDetailResponse`; `files` = practice `files/` entries with the `files/` prefix stripped; `counts` across all repos (every state key present, zeros included).
- `PUT /app/api/practices/:id` body `SavePracticeRequest` → validate with `parsePractice(yaml, id)`; on failure 400 `{ error: "Practice is invalid", issues }`; validate `files[].path` with the `RepoPath` rule; `commitCatalogChange` → 200 `CatalogWriteResponse`. Also update the stored catalog immediately (re-`loadCatalog`) so the next overview reflects it even before the webhook arrives.
- `DELETE /app/api/practices/:id` → removes `practices/<id>/` → 200 `CatalogWriteResponse`; 404 if unknown id.
- `POST /app/api/refresh` body `RefreshRequest` → enqueue one repo (404 if unknown) or all, `reason: "manual"` → 202 `RefreshResponse`.
- Mutating methods: existing `sameOrigin` check (403) + JSON content type (400).

`commitCatalogChange` uses the Git Data API on `CATALOG_REPO` with the installation client: get ref `heads/<default>` → base commit → base tree → create blobs → create tree with `base_tree` (deletions: entries with `sha: null` for every existing path under `practices/<id>/`) → create commit (message per Global Constraints) → update ref (`force: false`). Every write call goes through a wrapper that first calls `assertCatalogWrite`.

- [ ] **Step 1: Failing unit tests for `assertCatalogWrite`**: `aranlucas/practices` ok; `ARANLUCAS/Practices` ok; `aranlucas/shipshape-mcp` throws; `sidequest-labs/practices` throws.
- [ ] **Step 2: Failing API tests** (seed D1 directly via store functions; signed-in session via `createSession` + cookie): overview shape matches (use a zod mirror of `OverviewResponse` in `test/helpers/contract-schemas.ts` to assert shape, so contract drift breaks tests); repo detail 200/404; practice detail counts include zeros; PUT invalid YAML → 400 with `issues[0].path === "checks.0.type"` and no GitHub write calls; PUT valid → Git Data API sequence called in order and response `{ catalogSha }`; PUT from another origin → 403; DELETE unknown → 404; refresh one → 202 `{ queued: 1 }`; unauthenticated → 401.
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement.** **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `feat: serve the practices dashboard API`

---

### Task 11: MCP tools

**Files:**

- Rewrite: `src/mcp.ts`
- Modify: `src/index.ts`
- Test: rewrite `test/mcp-standards.test.ts` → `test/workers/mcp-practices.test.ts`

**Interfaces:**

- Produces: `createPracticesServer(env: AppEnv): McpServer` registering:
  - `practices_overview({ owner?: string, state?: PracticeState })` → `OverviewResponse` filtered: `owner` filters repos (and their results); `state` keeps only cells with that state and repos that have at least one.
  - `repo_practices({ owner, repo })` → `RepoDetailResponse`.
  - `practice_detail({ id })` → `PracticeDetailResponse`.
    All with the existing `READ_ONLY_ANNOTATIONS`, `structuredContent` + JSON text content, and `toolError` mapping (keep the function; drop `PrivateRepositoryError` branch). Share the response-building code with `src/api/routes.ts` (extract `buildOverview`, `buildRepoDetail`, `buildPracticeDetail` into `src/practices/views.ts` and use them from both).
- `src/index.ts`: `createMcpHandler(() => createPracticesServer(env), ...)` — the handler factory needs `env`; build the handler per request inside `protectedHandler.fetch(request, env, ctx)`. Remove the Task 3 stub.

- [ ] **Step 1: Failing test**: MCP client (`@modelcontextprotocol/client`, as the existing test does) lists exactly the three tools; `practices_overview` with seeded D1 returns structured content matching the contract zod mirror; `state: "fail"` filter works; `repo_practices` unknown repo → tool error text `Repository not found`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: replace scoring MCP tools with practice tools`

---

### Task 12: Retire the old product surface

**Files:** delete everything in the File Structure DELETE list; delete `src/drift/**` after moving anything still imported (branch-protection reading/`protectionState`/`BranchProtectionFact`, glob matcher, branch-protection key list, workflow helpers) into `src/practices/`. Move `src/standards/lint-config.ts` and `config-value.ts` to `src/practices/` (lint-config is kept for a future `oxforge-lint` check type; it must still have its tests). Delete tests for deleted code: `test/domain/**`, `test/review/**`, `test/drift/**` (port any test of moved helpers to `test/practices/`), `test/github/collectors.test.ts`, `test/github/convergence.test.ts`, `test/github/standards.test.ts`, `test/landing.test.ts` only if landing changes.

- [ ] **Step 1:** `grep -rn "PrivateRepositoryError\|public repositor\|read:user\|portfolio_snapshot\|settings_drift\|standards_audit" src test docs README.md` → expect hits; remove/update each.
- [ ] **Step 2:** Update the landing page (`src/landing.ts`) copy only (no styling): one-line description "Shipshape checks Lucas's engineering practices across his repositories." and a sign-in link to `/app`. Update `test/landing.test.ts` expectations.
- [ ] **Step 3:** Run `pnpm check` → PASS. Fix unused exports flagged by oxlint.
- [ ] **Step 4:** `grep` from Step 1 → no hits outside `docs/superpowers/` and git history.
- [ ] **Step 5: Commit** `refactor: remove the public portfolio scoring surface`

---

### Task 13: Seed catalog, setup docs, README

**Files:**

- Create: `catalog-seed/practices/<id>/practice.yml` (+ `files/` and `instructions.md` where useful) for the 8 seed practices in the spec; `docs/setup.md`.
- Modify: `README.md`, `docs/architecture.md`, `SECURITY.md` (scope statement), `.oxlintrc.json`/oxfmt ignore if needed for `catalog-seed/`.
- Test: `test/practices/seed.test.ts`

Seed content must mirror this repository's actual files (copy them): `files/.husky/pre-commit` from `.husky/pre-commit`; `files/oxfmt.config.ts` from `oxfmt.config.ts`; dependabot yaml-path checks from `.github/dependabot.yml`; ci checks from `.github/workflows/ci.yml` (`file-contains "uses: pnpm/setup@"`, `yaml-path permissions.contents = read`). `oxforge-lint-format`: `dependency @aranlucas/oxforge 0.2.2`, `file-contains .oxlintrc.json "@aranlucas/oxforge/configs/recommended.json"`, `file-matches oxfmt.config.ts`. Each `instructions.md` tells the fixing agent what to adapt per repo (e.g. dependabot ecosystems should match the repo's package managers).

- [ ] **Step 1: Failing test** `test/practices/seed.test.ts`: every `catalog-seed/practices/*/practice.yml` parses with `parsePractice(text, folder)`; every `file-matches` source exists in that folder; and evaluating the seed catalog against an in-memory snapshot built from **this repository's own files** (read from disk with `node:fs` in the node test project) yields `pass` for the 6 file/workflow practices.
- [ ] **Step 2: Run** → FAIL. **Step 3: Write the seed files.** **Step 4: Run** → PASS.
- [ ] **Step 5: Write `docs/setup.md`**: create the GitHub App (name, homepage, callback `${PUBLIC_ORIGIN}/callback`, "Request user authorization (OAuth) during installation" off, webhook URL `${PUBLIC_ORIGIN}/github/webhook`, secret, permissions table from the spec, events list), generate + convert the private key (`openssl pkcs8 -topk8 -nocrypt -in app.pem -out app.pkcs8.pem`), find your numeric id (`gh api user --jq .id`), install on `aranlucas` and `sidequest-labs` with "All repositories", create the D1 database and queue with `cf` (look up the exact commands with `cf cli search`; do not run them), apply migrations, set secrets, create the private `aranlucas/practices` repo and push `catalog-seed/` contents to it, local dev via `.dev.vars` or exported env vars + `pnpm dev`.
- [ ] **Step 6: Rewrite README** top section + architecture doc for the new product (single user, GitHub App, catalog repo, D1/Queue, MCP tools list, API contract pointer). Remove the old tool table and scoring sections.
- [ ] **Step 7:** `pnpm check` → PASS. **Commit** `docs: add seed practice catalog and GitHub App setup guide`

---

## Self-review notes

- Spec coverage: Access (Tasks 1–3), inventory (4), schema (5), catalog (6), checks/snapshot/bounds (7), states/D1/skip (8), triggers/queue/cron/webhook (9), API contract + editing + catalog-write allowlist (10), MCP tools (11), retirement (12), seed catalog + setup + docs (13). Fix requests are explicitly out of scope (spec sub-project 4).
- Review Focus items map to tests in Tasks 3, 5, 8, 9, 10.
