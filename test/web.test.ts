import { describe, expect, it, vi } from "vitest";

import type { OAuthEnv } from "@/oauth";
import { readSession } from "@/web/session";
import { isWebPath, webHandler } from "@/web/routes";
import { memoryKv } from "@test/helpers/oauth-state";

const ORIGIN = "https://shipshape.example";

interface GitHubUserFixture {
  login: string;
  id: number;
}

function environment() {
  const kv = memoryKv();

  const env: OAuthEnv = {
    OAUTH_KV: kv,
    OAUTH_PROVIDER: {
      parseAuthRequest: vi.fn(),
      lookupClient: vi.fn(),
      completeAuthorization: vi.fn(),
    },
    GITHUB_APP_CLIENT_ID: "Iv1.synthetic",
    GITHUB_APP_CLIENT_SECRET: "synthetic-secret",
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

async function callbackFor(env: OAuthEnv, user: GitHubUserFixture) {
  const login = await webHandler(new Request(`${ORIGIN}/app/login`), env);
  const authorize = new URL(login.headers.get("Location") ?? "");
  const browser = cookie(login, "__Host-shipshape-web-login");

  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ access_token: "oauth-token", token_type: "bearer", scope: "" }),
    )
    .mockResolvedValueOnce(Response.json(user));

  vi.stubGlobal("fetch", fetchMock);

  const callback = await webHandler(
    new Request(
      `${ORIGIN}/callback?code=github-code&iss=https%3A%2F%2Fgithub.com%2Flogin%2Foauth&state=${authorize.searchParams.get("state") ?? ""}`,
      { headers: { Cookie: `__Host-shipshape-web-login=${browser}` } },
    ),
    env,
  );

  vi.unstubAllGlobals();

  return { callback, fetchMock };
}

describe("website companion", () => {
  it("routes only website state to the shared callback", () => {
    expect(isWebPath("/callback", "web_synthetic-state")).toBe(true);
    expect(isWebPath("/callback", "synthetic-mcp-state")).toBe(false);
    expect(isWebPath("/callback")).toBe(false);
  });

  it("uses the App OAuth client and omits the ignored scope", async () => {
    const { env } = environment();
    const response = await webHandler(new Request(`${ORIGIN}/app/login`), env);
    const authorize = new URL(response.headers.get("Location") ?? "");
    expect(authorize.searchParams.get("client_id")).toBe("Iv1.synthetic");
    expect(authorize.searchParams.has("scope")).toBe(false);
  });

  it("rejects a non-owner without creating a session", async () => {
    const { env } = environment();
    const { callback } = await callbackFor(env, { login: "someone", id: 2002 });
    expect(callback.status).toBe(403);
    expect(await callback.text()).toContain(
      "This Shipshape instance belongs to another GitHub account.",
    );
    expect(callback.headers.get("Set-Cookie")).toContain("__Host-shipshape-web-login=");
    expect(callback.headers.get("Set-Cookie")).not.toContain("__Host-shipshape-session=");
  });

  it("creates an identity-only owner session", async () => {
    const { env, kv } = environment();
    const { callback, fetchMock } = await callbackFor(env, { login: "aranlucas", id: 1001 });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe("/app");
    const session = cookie(callback, "__Host-shipshape-session");
    expect(
      await readSession(
        kv,
        new Request(`${ORIGIN}/app`, {
          headers: { Cookie: `__Host-shipshape-session=${session}` },
        }),
      ),
    ).toEqual({
      login: "aranlucas",
      userId: 1001,
    });

    const tokenExchange = fetchMock.mock.calls[0]?.[1]?.body;

    const tokenExchangeText =
      tokenExchange instanceof URLSearchParams
        ? tokenExchange.toString()
        : tokenExchange instanceof Uint8Array
          ? new TextDecoder().decode(tokenExchange)
          : "";

    expect(tokenExchangeText).toContain("client_id=Iv1.synthetic");
  });

  it("serves the dashboard shell with the signed-in login for every client route", async () => {
    const { env } = environment();

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
    };

    const { callback } = await callbackFor(env, { login: "aranlucas", id: 1001 });
    const session = `__Host-shipshape-session=${cookie(callback, "__Host-shipshape-session")}`;

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
          new Request(`${ORIGIN}${path}`, { headers: { Cookie: session } }),
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
    const { env } = environment();
    const { callback } = await callbackFor(env, { login: "aranlucas", id: 1001 });
    const session = `__Host-shipshape-session=${cookie(callback, "__Host-shipshape-session")}`;

    const page = await webHandler(
      new Request(`${ORIGIN}/app`, { headers: { Cookie: session } }),
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

  it("keeps sign-out same-origin protected", async () => {
    const { env } = environment();
    const { callback } = await callbackFor(env, { login: "aranlucas", id: 1001 });
    const session = `__Host-shipshape-session=${cookie(callback, "__Host-shipshape-session")}`;

    const crossSite = new Request(`${ORIGIN}/app/logout`, {
      method: "POST",
      headers: { Cookie: session, Origin: "https://evil.example" },
    });

    expect((await webHandler(crossSite, env)).status).toBe(403);
  });
});
