import { describe, expect, it, vi } from "vitest";
import type { OAuthEnv } from "../src/oauth";
import { webHandler } from "../src/web/routes";
import { memoryKv } from "./helpers/oauth-state";
import { jsonResponse, repository } from "./helpers/github-fixtures";

const ORIGIN = "https://shipshape.example";

function environment() {
  const kv = memoryKv();
  const put = vi.spyOn(kv, "put");

  const env: OAuthEnv = {
    OAUTH_KV: kv,
    OAUTH_PROVIDER: {
      parseAuthRequest: vi.fn(),
      lookupClient: vi.fn(),
      completeAuthorization: vi.fn(),
    },
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    PUBLIC_ORIGIN: ORIGIN,
  };

  return { env, put };
}

function cookie(response: Response, name: string): string {
  const match = (response.headers.get("Set-Cookie") ?? "").match(
    new RegExp(`${name}=([^;,]+)`, "u"),
  );

  if (!match?.[1]) throw new Error(`Missing ${name} cookie`);

  return match[1];
}

async function signIn(env: OAuthEnv) {
  const login = await webHandler(new Request(`${ORIGIN}/app/login`), env);
  const authorize = new URL(login.headers.get("Location") ?? "");
  const browser = cookie(login, "__Host-shipshape-web-login");

  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "gho_synthetic_web_token",
          token_type: "bearer",
          scope: "read:user",
        }),
      )
      .mockResolvedValueOnce(Response.json({ login: "octo" })),
  );

  const callback = await webHandler(
    new Request(
      `${ORIGIN}/callback/web?code=github-code&state=${authorize.searchParams.get("state") ?? ""}`,
      { headers: { Cookie: `__Host-shipshape-web-login=${browser}` } },
    ),
    env,
  );

  vi.unstubAllGlobals();

  return {
    login,
    authorize,
    callback,
    session: `__Host-shipshape-session=${cookie(callback, "__Host-shipshape-session")}`,
  };
}

function api(
  path: string,
  method: string,
  session: string | null,
  body?: string,
) {
  const headers = new Headers({
    Origin: ORIGIN,
    "Content-Type": "application/json",
  });

  if (session) headers.set("Cookie", session);

  return new Request(`${ORIGIN}${path}`, { method, headers, body });
}

describe("website companion", () => {
  it("offers GitHub sign-in under a strict script policy", async () => {
    const { env } = environment();
    const response = await webHandler(new Request(`${ORIGIN}/app`), env);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('href="/app/login"');
    expect(html).not.toContain("<script");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
  });

  it("signs in with read-only GitHub access and keeps the token encrypted", async () => {
    const { env, put } = environment();
    const { login, authorize, callback, session } = await signIn(env);

    expect(login.status).toBe(302);
    expect(authorize.origin).toBe("https://github.com");
    expect(authorize.searchParams.get("scope")).toBe("read:user");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/callback/web`,
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe("/app");
    expect(callback.headers.get("Set-Cookie")).toContain("HttpOnly");

    for (const [, value] of put.mock.calls)
      expect(value).not.toContain("gho_synthetic_web_token");

    const page = await webHandler(
      new Request(`${ORIGIN}/app`, { headers: { Cookie: session } }),
      env,
    );

    const html = await page.text();
    expect(html).toContain("@octo");
    expect(html).toContain('<script src="/app/app.js" defer></script>');
  });

  it("rejects callbacks from another browser and replayed state", async () => {
    const { env } = environment();
    const login = await webHandler(new Request(`${ORIGIN}/app/login`), env);

    const state = new URL(login.headers.get("Location") ?? "").searchParams.get(
      "state",
    );

    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const forged = await webHandler(
      new Request(`${ORIGIN}/callback/web?code=x&state=${state ?? ""}`, {
        headers: {
          Cookie: "__Host-shipshape-web-login=attacker-browser-token-000000000",
        },
      }),
      env,
    );

    const replay = await webHandler(
      new Request(`${ORIGIN}/callback/web?code=x&state=${state ?? ""}`, {
        headers: {
          Cookie: `__Host-shipshape-web-login=${cookie(login, "__Host-shipshape-web-login")}`,
        },
      }),
      env,
    );

    expect(forged.status).toBe(400);
    expect(replay.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a session and a same-origin request for the API", async () => {
    const { env } = environment();
    const { session } = await signIn(env);
    const body = JSON.stringify({ owner: "octo", policy: "version: 1" });

    const anonymous = await webHandler(
      api("/app/api/drift", "POST", null, body),
      env,
    );

    expect(anonymous.status).toBe(401);

    const crossSite = api("/app/api/drift", "POST", session, body);
    crossSite.headers.set("Origin", "https://evil.example");
    expect((await webHandler(crossSite, env)).status).toBe(403);

    const invalid = await webHandler(
      api("/app/api/drift", "POST", session, body),
      env,
    );

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: expect.stringContaining("Invalid settings policy"),
    });
  });

  it("runs settings drift with the signed-in user's token", async () => {
    const { env } = environment();
    const { session } = await signIn(env);
    const authorizations: string[] = [];

    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        authorizations.push(
          new Headers(init?.headers).get("authorization") ?? "",
        );
        expect(init?.method ?? "GET").toBe("GET");

        const response =
          url.pathname === "/users/octo/repos"
            ? jsonResponse([repository])
            : jsonResponse({ ...repository, has_wiki: true });

        Object.defineProperty(response, "url", { value: url.href });

        return response;
      },
    );

    const response = await webHandler(
      api(
        "/app/api/drift",
        "POST",
        session,
        JSON.stringify({
          owner: "octo",
          policy:
            "version: 1\nrules:\n  - id: tidy\n    features: {wiki: false}\n",
          limit: 5,
        }),
      ),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "drifted",
      repositories: [
        {
          repository: "octo/demo",
          remediation: [{ method: "PATCH", body: { has_wiki: false } }],
        },
      ],
    });
    expect(
      authorizations.every(
        (value) => value === "token gho_synthetic_web_token",
      ),
    ).toBe(true);
  });

  it("saves valid rules per account and signs out", async () => {
    const { env } = environment();
    const { session } = await signIn(env);

    const policy =
      "version: 1\nrules:\n  - id: tidy\n    features: {wiki: false}\n";

    const invalid = await webHandler(
      api(
        "/app/api/rules",
        "PUT",
        session,
        JSON.stringify({ policy: "rules: []" }),
      ),
      env,
    );

    expect(invalid.status).toBe(400);

    const saved = await webHandler(
      api("/app/api/rules", "PUT", session, JSON.stringify({ policy })),
      env,
    );

    expect(await saved.json()).toEqual({ saved: true });

    const loaded = await webHandler(api("/app/api/rules", "GET", session), env);
    expect(await loaded.json()).toEqual({ policy });

    const logout = await webHandler(api("/app/logout", "POST", session), env);
    expect(logout.status).toBe(303);

    const after = await webHandler(api("/app/api/rules", "GET", session), env);
    expect(after.status).toBe(401);
  });

  it("serves the dashboard script", async () => {
    const { env } = environment();
    const response = await webHandler(new Request(`${ORIGIN}/app/app.js`), env);

    expect(response.headers.get("Content-Type")).toBe(
      "text/javascript; charset=utf-8",
    );
    const script = await response.text();

    // Parsing (not running) the script catches template-string escaping mistakes.
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain("textContent");
    expect(script).not.toContain("innerHTML");
  });
});
