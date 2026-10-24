/* oxlint-disable anti-slop/require-readable-spacing */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { assert, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MCP_RESOURCE } from "@/config";
import type { AppEnv } from "@/env";
import worker from "@/index";
import { startDashboardLogin } from "@/web/login";
import { AUTH_SCOPE, authTokenFixture, type AuthTokenFixture } from "@test/helpers/auth-token";

// SAFETY: the Workers test bindings supply AppEnv; each request overrides external Auth settings.
const appEnv = env as AppEnv;
const unexpected: string[] = [];
const outgoing: Pick<Request, "url" | "json" | "text">[] = [];
let auth: AuthTokenFixture;

beforeAll(async () => {
  auth = await authTokenFixture();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input instanceof Request ? input.url : String(input), init);
    outgoing.push(request.clone());

    if (request.url === auth.jwksUrl) {
      return Response.json(auth.jwks);
    }

    if (request.url === `${auth.issuer}/oauth2/register`) {
      assert.equal(request.method, "POST");

      return Response.json({ client_id: "worker-dashboard-client" }, { status: 201 });
    }

    if (request.url === `${auth.issuer}/oauth2/token`) {
      assert.equal(request.method, "POST");
      const parameters = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
      assert.equal(parameters.get("resource"), MCP_RESOURCE);
      assert.match(parameters.get("code_verifier") ?? "", /^[A-Za-z0-9_-]{43,128}$/u);
      assert.equal(parameters.has("client_secret"), false);

      return Response.json({
        access_token: await auth.sign({ aud: MCP_RESOURCE, client_id: "worker-dashboard-client" }),
        token_type: "Bearer",
        expires_in: 300,
        scope: AUTH_SCOPE,
      });
    }

    unexpected.push(request.url);
    throw new Error(`Unexpected Worker outbound request: ${request.url}`);
  });

  // Load the Worker graph outside individual test timeouts.
  await dispatch(MCP_RESOURCE);
}, 30_000);

afterAll(() => {
  vi.restoreAllMocks();
  assert.deepEqual(unexpected, []);
});

async function dispatch(
  input: string | URL,
  init: RequestInit = {},
  overrides: Partial<AppEnv> = {},
) {
  const context = createExecutionContext();
  const headers = new Headers(init.headers);
  headers.set("Host", headers.get("X-Fixture-Host") ?? new URL(input).host);
  headers.delete("X-Fixture-Host");
  const response = await worker.fetch(
    new Request(input, { ...init, headers, redirect: "manual" }),
    {
      ...appEnv,
      BETTER_AUTH_ISSUER: auth.issuer,
      BETTER_AUTH_JWKS_URL: auth.jwksUrl,
      ...overrides,
    },
    context,
  );
  await waitOnExecutionContext(context);

  return response;
}

function mcpRequest(token?: string, headers: HeadersInit = {}): RequestInit {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Content-Type", "application/json");
  requestHeaders.set("Accept", "application/json, text/event-stream");
  requestHeaders.set("MCP-Protocol-Version", "2025-03-26");

  if (token !== undefined) {
    requestHeaders.set("Authorization", `Bearer ${token}`);
  }

  return {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  };
}

function cookie(response: Response, name: string) {
  const value = new RegExp(`${name}=([^;,]+)`, "u").exec(
    response.headers.get("Set-Cookie") ?? "",
  )?.[1];

  if (!value) {
    throw new Error(`Missing ${name} cookie`);
  }

  return value;
}

describe("external Auth resource server", () => {
  it.each(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"])(
    "serves public resource discovery at %s using the central issuer",
    async (path) => {
      const response = await dispatch(new URL(path, MCP_RESOURCE));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        resource: MCP_RESOURCE,
        authorization_servers: [auth.issuer],
        scopes_supported: [AUTH_SCOPE],
        bearer_methods_supported: ["header"],
      });
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    },
  );

  it("supports metadata HEAD and preflight without exposing a local authorization server", async () => {
    const metadata = new URL("/.well-known/oauth-protected-resource/mcp", MCP_RESOURCE);
    const head = await dispatch(metadata, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const options = await dispatch(metadata, { method: "OPTIONS" });
    expect(options.status).toBe(200);
    expect(options.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    const post = await dispatch(metadata, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    expect(
      (await dispatch(new URL("/.well-known/oauth-authorization-server", MCP_RESOURCE))).status,
    ).toBe(404);
  });

  it.each([
    ["/authorize", "GET", 404],
    ["/authorize", "POST", 405],
    ["/oauth/register", "POST", 405],
    ["/oauth/token", "POST", 405],
    ["/callback", "GET", 404],
  ])("removes local OAuth issuance route %s %s", async (path, method, status) => {
    const response = await dispatch(new URL(path, MCP_RESOURCE), { method });
    expect(response.status).toBe(status);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("starts browser authorization within the Worker runtime", async () => {
    const login = await startDashboardLogin(new Request(new URL("/app/login", MCP_RESOURCE)), {
      ...appEnv,
      BETTER_AUTH_ISSUER: auth.issuer,
      BETTER_AUTH_JWKS_URL: auth.jwksUrl,
    });
    expect(login.authorize.origin).toBe(auth.issuer);
  });

  it("advertises the preview resource and callback while retaining the central issuer", async () => {
    const origin = "https://branch-shipshape.example";
    const previewEnv = { PUBLIC_ORIGIN: "" };
    const metadata = await dispatch(
      `${origin}/.well-known/oauth-protected-resource/mcp`,
      {},
      previewEnv,
    );
    expect(await metadata.json()).toMatchObject({
      resource: `${origin}/mcp`,
      authorization_servers: [auth.issuer],
    });
    const login = await dispatch(`${origin}/app/login`, {}, previewEnv);
    expect(login.status).toBe(302);
    const authorize = new URL(login.headers.get("Location") ?? "");
    expect(authorize.origin).toBe(auth.issuer);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${origin}/callback/web`);
    expect(authorize.searchParams.get("resource")).toBe(`${origin}/mcp`);
  });

  it.each([undefined, "not-a-jwt"])(
    "challenges a missing or invalid bearer token %j",
    async (token) => {
      const response = await dispatch(MCP_RESOURCE, mcpRequest(token));
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toContain("Bearer ");
      expect(response.headers.get("WWW-Authenticate")).toContain(`scope="${AUTH_SCOPE}"`);
      expect(response.headers.get("WWW-Authenticate")).toContain(
        `resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", MCP_RESOURCE).href}"`,
      );
      expect(response.headers.get("Access-Control-Expose-Headers")).toContain("WWW-Authenticate");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    },
  );

  it("accepts a signed owner token and reaches the real MCP server", async () => {
    const token = await auth.sign({ aud: MCP_RESOURCE });
    const response = await dispatch(MCP_RESOURCE, mcpRequest(token));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"practices_overview"');

    const privateAudit = await dispatch(MCP_RESOURCE, {
      ...mcpRequest(token),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "repo_practices", arguments: { owner: "octo", repo: "demo" } },
      }),
    });
    expect(privateAudit.status).toBe(200);
    expect(await privateAudit.text()).toContain("Repository not found");
  });

  it("accepts the central Auth audience array when it includes the exact MCP resource", async () => {
    const token = await auth.sign({ aud: [MCP_RESOURCE, `${auth.issuer}/userinfo`] });
    const response = await dispatch(MCP_RESOURCE, mcpRequest(token));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"practices_overview"');
  });

  it("rejects another GitHub account even when the signed login matches the owner", async () => {
    const token = await auth.sign({ aud: MCP_RESOURCE, github_id: "2002" });
    const response = await dispatch(MCP_RESOURCE, mcpRequest(token));
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
  });

  it.each([
    ["unlinked account", { github_id: undefined, github_login: undefined }],
    [
      "legacy provider identity props",
      { github_id: undefined, github_login: undefined, login: "aranlucas", userId: 1001 },
    ],
    ["numeric GitHub id", { github_id: 1001 }],
    ["unsafe GitHub id", { github_id: "9007199254740992" }],
    ["malformed GitHub login", { github_login: "<script>" }],
    ["future issued-at", { iat: 4_000_000_000 }],
  ])("rejects verified but unusable identity claims: %s", async (_label, claims) => {
    const response = await dispatch(
      MCP_RESOURCE,
      mcpRequest(await auth.sign({ aud: MCP_RESOURCE, ...claims })),
    );
    expect(response.status).toBe(403);
  });

  it.each([
    ["wrong issuer", { iss: "https://attacker.example" }],
    ["wrong audience", { aud: "https://other.example/mcp" }],
    ["origin audience", { aud: new URL(MCP_RESOURCE).origin }],
    ["expired token", { exp: 1 }],
    ["missing expiration", { exp: undefined }],
    ["missing issued-at", { iat: undefined }],
    ["missing subject", { sub: undefined }],
    ["missing client id", { client_id: undefined }],
  ])("challenges a JWT with %s", async (_label, claims) => {
    const response = await dispatch(
      MCP_RESOURCE,
      mcpRequest(await auth.sign({ aud: MCP_RESOURCE, ...claims })),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Bearer ");
  });

  it("rejects a proof-bound token presented without its DPoP proof", async () => {
    const token = await auth.sign({ aud: MCP_RESOURCE, cnf: { jkt: "proof-key-thumbprint" } });
    const response = await dispatch(MCP_RESOURCE, mcpRequest(token));

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain('DPoP error="invalid_token"');
  });

  it("rejects a JWT signed by an untrusted key", async () => {
    const attacker = await authTokenFixture();
    const response = await dispatch(
      MCP_RESOURCE,
      mcpRequest(await attacker.sign({ aud: MCP_RESOURCE })),
    );
    expect(response.status).toBe(401);
  });

  it.each(["JWT", undefined])("rejects token type %j", async (typ) => {
    const response = await dispatch(
      MCP_RESOURCE,
      mcpRequest(await auth.sign({ aud: MCP_RESOURCE }, { typ })),
    );
    expect(response.status).toBe(401);
  });

  it("rejects algorithms outside the configured asymmetric allowlist", async () => {
    const unsupported = await authTokenFixture("RS512");
    const response = await dispatch(
      MCP_RESOURCE,
      mcpRequest(await unsupported.sign({ aud: MCP_RESOURCE })),
    );
    expect(response.status).toBe(401);
  });

  it.each(["other:access", "shipshape:access:admin"])(
    "reports insufficient scope for %s",
    async (scope) => {
      const response = await dispatch(
        MCP_RESOURCE,
        mcpRequest(await auth.sign({ aud: MCP_RESOURCE, scope })),
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("WWW-Authenticate")).toContain('error="insufficient_scope"');
      expect(response.headers.get("WWW-Authenticate")).toContain(`scope="${AUTH_SCOPE}"`);
    },
  );

  it("rejects an untrusted Host before handling a valid owner token", async () => {
    const token = await auth.sign({ aud: MCP_RESOURCE });
    const response = await dispatch(
      MCP_RESOURCE,
      mcpRequest(token, { "X-Fixture-Host": "attacker.example" }),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Invalid Host");
  });

  it("rejects a cross-origin MCP request before verifying its token", async () => {
    const response = await dispatch(
      MCP_RESOURCE,
      mcpRequest(undefined, { Origin: "https://attacker.example" }),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Origin not allowed");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("allows explicit browser origins and returns their CORS headers", async () => {
    const origin = "https://chatgpt.com";
    const allowed = { MCP_ALLOWED_ORIGINS: JSON.stringify([origin]) };
    const preflight = await dispatch(
      MCP_RESOURCE,
      { method: "OPTIONS", headers: { Origin: origin } },
      allowed,
    );
    expect(preflight.status).toBe(200);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    const response = await dispatch(
      MCP_RESOURCE,
      mcpRequest(await auth.sign({ aud: MCP_RESOURCE }), { Origin: origin }),
      allowed,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Vary")).toContain("Origin");
  });

  it("signs the dashboard in through central Auth, KV state, JWT verification and the real web handler", async () => {
    const login = await dispatch(new URL("/app/login", MCP_RESOURCE));
    expect(login.status).toBe(302);
    const authorize = new URL(login.headers.get("Location") ?? "");
    const browser = cookie(login, "__Host-shipshape-web-login");
    const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    callback.search = new URLSearchParams({
      code: "worker-auth-code",
      iss: auth.issuer,
      state: authorize.searchParams.get("state") ?? "",
    }).toString();
    const completed = await dispatch(callback, {
      headers: { Cookie: `__Host-shipshape-web-login=${browser}` },
    });
    expect(completed.status).toBe(302);
    expect(completed.headers.get("Location")).toBe("/app");
    const session = cookie(completed, "__Host-shipshape-session");
    const page = await dispatch(new URL("/app", MCP_RESOURCE), {
      headers: { Cookie: `__Host-shipshape-session=${session}` },
    });
    expect(await page.text()).toContain("Signed in as <strong>@aranlucas</strong>");
    expect(
      (await dispatch(callback, { headers: { Cookie: `__Host-shipshape-web-login=${browser}` } }))
        .status,
    ).toBe(400);
    expect(outgoing.some((request) => request.url.includes("github.com"))).toBe(false);
  });
});
