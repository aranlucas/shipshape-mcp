import { calculatePKCECodeChallenge } from "oauth4webapi";
import type { JWTPayload } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { OAuthEnv } from "@/oauth";
import { createSession, readSession } from "@/web/session";
import { isWebPath, webHandler } from "@/web/routes";
import { memoryKv } from "@test/helpers/oauth-state";
import { AUTH_SCOPE, authTokenFixture, type AuthTokenFixture } from "@test/helpers/auth-token";

const ORIGIN = "https://shipshape.example";

const CLIENT_ID = "dashboard-public-client";

let auth: AuthTokenFixture;

beforeAll(async () => {
  auth = await authTokenFixture();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function environment() {
  const kv = memoryKv();

  const env: OAuthEnv = {
    OAUTH_KV: kv,
    BETTER_AUTH_ISSUER: auth.issuer,
    BETTER_AUTH_JWKS_URL: auth.jwksUrl,
    OWNER_GITHUB_ID: "1001",
    PUBLIC_ORIGIN: ORIGIN,
  };

  return { env, kv };
}

function cookie(response: Response, name: string): string {
  const match = (response.headers.get("Set-Cookie") ?? "").match(
    new RegExp(`${name}=([^;,]+)`, "u"),
  );

  if (!match?.[1]) {
    throw new Error(`Missing ${name} cookie`);
  }

  return match[1];
}

async function beginLogin(env: OAuthEnv, claims: JWTPayload = {}) {
  const token = await auth.sign({ client_id: CLIENT_ID, ...claims });
  const requests: Pick<Request, "url" | "json" | "text">[] = [];

  const fetchMock = vi.fn<typeof fetch>().mockImplementation((input, init) => {
    const request = new Request(input instanceof Request ? input.url : String(input), init);
    requests.push(request.clone());

    if (request.url === `${auth.issuer}/oauth2/register`) {
      return Promise.resolve(Response.json({ client_id: CLIENT_ID }, { status: 201 }));
    }

    if (request.url === `${auth.issuer}/oauth2/token`) {
      return Promise.resolve(
        Response.json({
          access_token: token,
          token_type: "Bearer",
          expires_in: 300,
          scope: AUTH_SCOPE,
        }),
      );
    }

    if (request.url === auth.jwksUrl) {
      return Promise.resolve(Response.json(auth.jwks));
    }

    return Promise.reject(new Error(`Unexpected authentication request: ${request.url}`));
  });

  vi.stubGlobal("fetch", fetchMock);

  const login = await webHandler(new Request(`${ORIGIN}/app/login`), env);
  const authorize = new URL(login.headers.get("Location") ?? "");
  const browser = cookie(login, "__Host-shipshape-web-login");
  const callbackUrl = new URL(authorize.searchParams.get("redirect_uri") ?? "");
  callbackUrl.search = new URLSearchParams({
    code: "auth-authorization-code",
    iss: auth.issuer,
    state: authorize.searchParams.get("state") ?? "",
  }).toString();

  function finish(url = callbackUrl, browserCookie: string | null = browser) {
    return webHandler(
      new Request(url, {
        headers:
          browserCookie === null ? {} : { Cookie: `__Host-shipshape-web-login=${browserCookie}` },
      }),
      env,
    );
  }

  return { login, authorize, browser, callbackUrl, finish, fetchMock, requests };
}

describe("website companion", () => {
  it("routes the website callback without retaining the old MCP callback", () => {
    expect(isWebPath("/callback/web")).toBe(true);
    expect(isWebPath("/callback")).toBe(false);
  });

  it("registers a public client and requests central Auth authorization with PKCE", async () => {
    const { env } = environment();
    const { login, authorize, requests } = await beginLogin(env);

    expect(login.status).toBe(302);
    expect(authorize.origin).toBe(auth.issuer);
    expect(authorize.pathname).toBe("/oauth2/authorize");
    expect(authorize.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/callback/web`);
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(authorize.searchParams.get("scope")).toBe(AUTH_SCOPE);
    expect(authorize.searchParams.get("resource")).toBe(`${ORIGIN}/mcp`);
    expect(authorize.searchParams.get("state")).toMatch(/^web_[A-Za-z0-9_-]+$/u);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(authorize.searchParams.has("code_verifier")).toBe(false);
    expect(authorize.searchParams.has("client_secret")).toBe(false);
    expect(login.headers.get("Set-Cookie")).toContain("Path=/; HttpOnly; Secure; SameSite=Lax");
    expect(login.headers.get("Cache-Control")).toBe("no-store");
    expect(await requests[0]?.json()).toMatchObject({
      redirect_uris: [`${ORIGIN}/callback/web`],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: AUTH_SCOPE,
      resources: [`${ORIGIN}/mcp`],
    });
  });

  it("reuses a registration only for its exact callback origin", async () => {
    const { env } = environment();
    const { requests } = await beginLogin(env);
    await webHandler(new Request(`${ORIGIN}/app/login`), env);
    await webHandler(new Request("https://preview.example/app/login"), {
      ...env,
      PUBLIC_ORIGIN: "",
    });
    const registrations = requests.filter((request) => request.url.endsWith("/oauth2/register"));

    expect(registrations).toHaveLength(2);
    expect(await registrations[1]?.json()).toMatchObject({
      redirect_uris: ["https://preview.example/callback/web"],
      resources: ["https://preview.example/mcp"],
    });
  });

  it("registers a new client when the Auth issuer changes", async () => {
    const { env } = environment();
    const { fetchMock } = await beginLogin(env);
    const issuer = "https://other-auth.example/api/auth";
    fetchMock.mockResolvedValueOnce(
      Response.json({ client_id: "other-issuer-client" }, { status: 201 }),
    );

    const response = await webHandler(new Request(`${ORIGIN}/app/login`), {
      ...env,
      BETTER_AUTH_ISSUER: issuer,
      BETTER_AUTH_JWKS_URL: `${issuer}/jwks`,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toEqual(new URL(`${issuer}/oauth2/register`));
    expect(new URL(response.headers.get("Location") ?? "").searchParams.get("client_id")).toBe(
      "other-issuer-client",
    );
  });

  it("rejects registration redirects without forwarding registration to another host", async () => {
    const { env } = environment();

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: "https://attacker.example/register" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await expect(webHandler(new Request(`${ORIGIN}/app/login`), env)).rejects.toThrow(
      "Dashboard client registration unavailable",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(new URL(`${auth.issuer}/oauth2/register`));
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("rejects token redirects without forwarding the code or verifier and consumes callback state", async () => {
    const { env } = environment();
    const { finish, fetchMock } = await beginLogin(env);
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 307,
        headers: { Location: "https://attacker.example/token" },
      }),
    );

    expect((await finish()).status).toBe(400);
    expect((await finish()).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${auth.issuer}/oauth2/token`);
    expect(fetchMock.mock.calls[1]?.[1]?.redirect).toBe("manual");
  });

  it("creates an identity-only owner session bounded by the verified token expiration", async () => {
    const { env, kv } = environment();
    const put = vi.spyOn(kv, "put");
    const expiresAt = Math.floor(Date.now() / 1_000) + 120;
    const { finish, authorize, requests } = await beginLogin(env, { exp: expiresAt });
    const callback = await finish();

    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe("/app");
    const session = cookie(callback, "__Host-shipshape-session");

    const request = new Request(`${ORIGIN}/app`, {
      headers: { Cookie: `__Host-shipshape-session=${session}` },
    });

    expect(await readSession(kv, request)).toEqual({ login: "aranlucas", userId: 1001 });
    const record = put.mock.calls.find(([key]) => key.startsWith("web:session:"));
    const stored: unknown = JSON.parse(record?.[1] ?? "null");
    expect(stored).toMatchObject({ login: "aranlucas", userId: 1001, expiresAt });
    expect(stored).toHaveProperty("createdAt");
    expect(record?.[1]).not.toContain("token");
    expect(record?.[0]).not.toContain(session);

    const cookieTtl = Number(
      /__Host-shipshape-session=[^;]+;[^,]*Max-Age=(\d+)/u.exec(
        callback.headers.get("Set-Cookie") ?? "",
      )?.[1],
    );

    expect(cookieTtl).toBeGreaterThan(0);
    expect(cookieTtl).toBeLessThanOrEqual(120);

    const exchange = requests.find((outbound) => outbound.url.endsWith("/oauth2/token"));
    const parameters = new URLSearchParams(await exchange?.text());
    expect(parameters.get("client_id")).toBe(CLIENT_ID);
    expect(parameters.get("redirect_uri")).toBe(`${ORIGIN}/callback/web`);
    expect(parameters.get("resource")).toBe(`${ORIGIN}/mcp`);
    expect(parameters.get("grant_type")).toBe("authorization_code");
    expect(parameters.has("client_secret")).toBe(false);
    expect(await calculatePKCECodeChallenge(parameters.get("code_verifier") ?? "")).toBe(
      authorize.searchParams.get("code_challenge"),
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date(expiresAt * 1_000));
    expect(await readSession(kv, request)).toBeNull();
  });

  it.each([
    ["another owner", { github_id: "2002", github_login: "someone" }, 403],
    ["unlinked GitHub account", { github_id: undefined }, 400],
    ["another OAuth client", { client_id: "other-client" }, 400],
    ["wrong resource", { aud: "https://other.example/mcp" }, 400],
    ["expired access token", { exp: 1 }, 400],
  ])("does not create a session for %s", async (_label, claims, status) => {
    const { env } = environment();
    const { finish } = await beginLogin(env, claims);
    const callback = await finish();

    expect(callback.status).toBe(status);
    expect(callback.headers.get("Set-Cookie")).toContain("__Host-shipshape-web-login=");
    expect(callback.headers.get("Set-Cookie")).not.toContain("__Host-shipshape-session=");
  });

  it.each([null, "a-different-browser-cookie-123456"])(
    "rejects missing or mismatched browser binding %j before exchanging a code",
    async (browser) => {
      const { env } = environment();
      const { finish, callbackUrl, requests } = await beginLogin(env);
      expect((await finish(callbackUrl, browser)).status).toBe(400);
      expect(requests.some((request) => request.url.endsWith("/oauth2/token"))).toBe(false);
    },
  );

  it("consumes callback state once and rejects issuer mix-up before a code exchange", async () => {
    const { env } = environment();
    const { finish, callbackUrl, requests } = await beginLogin(env);
    callbackUrl.searchParams.set("iss", "https://attacker.example");
    expect((await finish()).status).toBe(400);
    callbackUrl.searchParams.set("iss", auth.issuer);
    expect((await finish()).status).toBe(400);
    expect(requests.some((request) => request.url.endsWith("/oauth2/token"))).toBe(false);
  });

  it("requires an issuer in the authorization callback before exchanging a code", async () => {
    const { env } = environment();
    const { finish, callbackUrl, requests } = await beginLogin(env);
    callbackUrl.searchParams.delete("iss");

    expect((await finish()).status).toBe(400);
    expect(requests.some((request) => request.url.endsWith("/oauth2/token"))).toBe(false);
  });

  it("rejects a successful callback replay", async () => {
    const { env } = environment();
    const { finish, requests } = await beginLogin(env);
    expect((await finish()).status).toBe(302);
    expect((await finish()).status).toBe(400);
    expect(requests.filter((request) => request.url.endsWith("/oauth2/token"))).toHaveLength(1);
  });

  it("serves the dashboard shell with the signed-in login for every client route", async () => {
    const { env, kv } = environment();

    const shell =
      '<!doctype html><html><head><meta name="shipshape-login" content=""></head><body><div id="root"></div></body></html>';

    env.ASSETS = {
      fetch: vi.fn((request: Request) =>
        Promise.resolve(
          new URL(request.url).pathname === "/app/index.html"
            ? new Response(shell, { headers: { "Content-Type": "text/html" } })
            : new Response("Not found", { status: 404 }),
        ),
      ),
      connect: vi.fn(() => {
        throw new Error("Unexpected asset socket connection");
      }),
    };
    const secret = await createSession(kv, { login: "aranlucas", userId: 1001 });

    const paths = [
      "/app",
      "/app/repos/aranlucas/shipshape-mcp",
      "/app/practices",
      "/app/practices/husky-lint-staged",
      "/app/practices/new",
    ];

    const pages = await Promise.all(
      paths.map(async (path) => {
        const page = await webHandler(
          new Request(`${ORIGIN}${path}`, {
            headers: { Cookie: `__Host-shipshape-session=${secret}` },
          }),
          env,
        );

        return { page, body: await page.text() };
      }),
    );

    for (const { page, body } of pages) {
      expect(page.status).toBe(200);
      expect(body).toContain('<meta name="shipshape-login" content="aranlucas">');
      expect(page.headers.get("Content-Security-Policy")).toContain("font-src 'self'");
      expect(page.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("asks signed-out visitors to sign in on any dashboard route", async () => {
    const { env } = environment();
    const page = await webHandler(new Request(`${ORIGIN}/app/practices/husky-lint-staged`), env);

    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Continue with GitHub");
  });

  it("explains a missing bundle and removes retired APIs and assets", async () => {
    const { env, kv } = environment();
    const secret = await createSession(kv, { login: "aranlucas", userId: 1001 });

    const page = await webHandler(
      new Request(`${ORIGIN}/app`, {
        headers: { Cookie: `__Host-shipshape-session=${secret}` },
      }),
      env,
    );

    expect(await page.text()).toContain("pnpm ui:build");
    expect(
      (await webHandler(new Request(`${ORIGIN}/app/api/drift`, { method: "POST" }), env)).status,
    ).toBe(404);
    expect((await webHandler(new Request(`${ORIGIN}/app/app.js`), env)).status).toBe(404);
    expect((await webHandler(new Request(`${ORIGIN}/app/review.js`), env)).status).toBe(404);
    expect((await webHandler(new Request(`${ORIGIN}/app/review`), env)).status).toBe(404);
  });

  it("keeps sign-out same-origin protected and deletes the local session on success", async () => {
    const { env, kv } = environment();
    const secret = await createSession(kv, { login: "aranlucas", userId: 1001 });
    const headers = { Cookie: `__Host-shipshape-session=${secret}` };

    const crossSite = new Request(`${ORIGIN}/app/logout`, {
      method: "POST",
      headers: { ...headers, Origin: "https://evil.example" },
    });

    expect((await webHandler(crossSite, env)).status).toBe(403);
    expect(await readSession(kv, crossSite)).not.toBeNull();

    const loggedOut = await webHandler(
      new Request(`${ORIGIN}/app/logout`, {
        method: "POST",
        headers: { ...headers, Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      }),
      env,
    );

    expect(loggedOut.status).toBe(303);
    expect(loggedOut.headers.get("Set-Cookie")).toContain("__Host-shipshape-session=;");
    expect(await readSession(kv, crossSite)).toBeNull();
  });
});
