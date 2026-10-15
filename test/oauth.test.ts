import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithTimeout, createOAuthHandler, type OAuthEnv } from "@/oauth";

const { handleDefaultRequest } = createOAuthHandler({
  authorizationError() {
    throw new Error("Unexpected authorization parse failure");
  },
});

import { memoryKv } from "@test/helpers/oauth-state";

const requestDetails: AuthRequest = {
  clientId: "client-1",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256",
  redirectUri: "https://client.example/callback",
  responseType: "code",
  scope: ["mcp:read"],
  state: "client-state",
  issuer: "https://shipshape.example",
};

const client: ClientInfo = {
  clientId: "client-1",
  clientName: "Test MCP Client",
  redirectUris: [requestDetails.redirectUri],
  tokenEndpointAuthMethod: "none",
};

function hiddenValue(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`, "u"));

  if (!match?.[1]) {
    throw new Error(`Missing ${name} field`);
  }

  return match[1];
}

function cookieValue(response: Response, name: string): string {
  const header = response.headers.get("Set-Cookie") ?? "";
  const match = header.match(new RegExp(`${name}=([^;,]+)`, "u"));

  if (!match?.[1]) {
    throw new Error(`Missing ${name} cookie`);
  }

  return match[1];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OAuth proxy flow", () => {
  it("requires local consent, binds callback state, and grants only the MCP read scope", async () => {
    const completeAuthorization = vi.fn().mockResolvedValue({
      redirectTo: "https://client.example/callback?code=provider-code",
    });

    const helpers = {
      parseAuthRequest: vi.fn().mockResolvedValue(requestDetails),
      lookupClient: vi.fn().mockResolvedValue(client),
      completeAuthorization,
    } satisfies OAuthEnv["OAUTH_PROVIDER"];

    const env: OAuthEnv = {
      OAUTH_KV: memoryKv(),
      OAUTH_PROVIDER: helpers,
      GITHUB_APP_CLIENT_ID: "Iv1.synthetic",
      GITHUB_APP_CLIENT_SECRET: "github-client-secret",
      OWNER_GITHUB_ID: "1001",
      COOKIE_ENCRYPTION_KEY: "cookie-signing-key",
      GITHUB_API_VERSION: "2026-03-10",
      PUBLIC_ORIGIN: "https://shipshape.example",
    };

    const consent = await handleDefaultRequest(
      new Request("https://shipshape.example/authorize?client_id=client-1"),
      env,
    );

    const consentHtml = await consent.text();
    const browser = cookieValue(consent, "__Host-shipshape-browser");
    const csrfCookie = cookieValue(consent, "__Host-shipshape-csrf");
    const consentState = hiddenValue(consentHtml, "state");
    const csrfField = hiddenValue(consentHtml, "csrf");

    expect(consent.status).toBe(200);
    expect(consentHtml).toContain("Test MCP Client");
    expect(csrfField).toBe(csrfCookie);
    expect(consent.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; style-src 'self'; frame-ancestors 'none'",
    );

    const approve = await handleDefaultRequest(
      new Request("https://shipshape.example/authorize", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `__Host-shipshape-browser=${browser}; __Host-shipshape-csrf=${csrfCookie}`,
        },
        body: new URLSearchParams({
          state: consentState,
          csrf: csrfField,
          decision: "approve",
        }),
      }),
      env,
    );

    const githubAuthorize = new URL(approve.headers.get("Location") ?? "");

    expect(approve.status).toBe(302);
    expect(githubAuthorize.origin).toBe("https://github.com");
    expect(githubAuthorize.searchParams.has("scope")).toBe(false);
    expect(githubAuthorize.searchParams.get("redirect_uri")).toBe(
      "https://shipshape.example/callback",
    );

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "oauth_test_public_token",
          token_type: "bearer",
          scope: "",
        }),
      )
      .mockResolvedValueOnce(Response.json({ login: "AranLucas", id: 1001 }));

    vi.stubGlobal("fetch", fetchMock);

    const callback = await handleDefaultRequest(
      new Request(
        `https://shipshape.example/callback?code=github-code&iss=https%3A%2F%2Fgithub.com%2Flogin%2Foauth&state=${githubAuthorize.searchParams.get("state") ?? ""}`,
        { headers: { Cookie: `__Host-shipshape-browser=${browser}` } },
      ),
      env,
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe(
      "https://client.example/callback?code=provider-code",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(completeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "github-1001",
        scope: ["mcp:read"],
        props: {
          login: "AranLucas",
          userId: 1001,
        },
      }),
    );
  });

  it("rejects a non-owner MCP callback before completing authorization", async () => {
    const completeAuthorization = vi.fn();

    const env: OAuthEnv = {
      OAUTH_KV: memoryKv(),
      OAUTH_PROVIDER: {
        parseAuthRequest: vi.fn().mockResolvedValue(requestDetails),
        lookupClient: vi.fn().mockResolvedValue(client),
        completeAuthorization,
      },
      GITHUB_APP_CLIENT_ID: "Iv1.synthetic",
      GITHUB_APP_CLIENT_SECRET: "github-client-secret",
      OWNER_GITHUB_ID: "1001",
      COOKIE_ENCRYPTION_KEY: "cookie-signing-key",
      PUBLIC_ORIGIN: "https://shipshape.example",
    };

    const consent = await handleDefaultRequest(
      new Request("https://shipshape.example/authorize"),
      env,
    );

    const consentHtml = await consent.text();
    const browser = cookieValue(consent, "__Host-shipshape-browser");
    const csrf = cookieValue(consent, "__Host-shipshape-csrf");

    const approved = await handleDefaultRequest(
      new Request("https://shipshape.example/authorize", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `__Host-shipshape-browser=${browser}; __Host-shipshape-csrf=${csrf}`,
        },
        body: new URLSearchParams({
          state: hiddenValue(consentHtml, "state"),
          csrf,
          decision: "approve",
        }),
      }),
      env,
    );

    const github = new URL(approved.headers.get("Location") ?? "");
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ access_token: "token", token_type: "bearer" }))
        .mockResolvedValueOnce(Response.json({ login: "someone", id: 2002 })),
    );

    const response = await handleDefaultRequest(
      new Request(
        `https://shipshape.example/callback?code=github-code&state=${github.searchParams.get("state") ?? ""}`,
        { headers: { Cookie: `__Host-shipshape-browser=${browser}` } },
      ),
      env,
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain(
      "This Shipshape instance belongs to another GitHub account.",
    );
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it.each([
    "https://client.example/callback",
    "http://127.0.0.1:49152/callback",
    "claude://oauth/callback",
  ])("allows denying consent back to %s", async (redirectUri) => {
    const env: OAuthEnv = {
      OAUTH_KV: memoryKv(),
      OAUTH_PROVIDER: {
        parseAuthRequest: vi.fn().mockResolvedValue({
          ...requestDetails,
          redirectUri,
        }),
        lookupClient: vi.fn().mockResolvedValue({
          ...client,
          redirectUris: [redirectUri],
        }),
        completeAuthorization: () =>
          Promise.reject(new Error("Unexpected authorization completion")),
      } satisfies OAuthEnv["OAUTH_PROVIDER"],
      GITHUB_APP_CLIENT_ID: "Iv1.synthetic",
      GITHUB_APP_CLIENT_SECRET: "github-client-secret",
      OWNER_GITHUB_ID: "1001",
      COOKIE_ENCRYPTION_KEY: "cookie-signing-key",
      PUBLIC_ORIGIN: "https://shipshape.example",
    };

    const consent = await handleDefaultRequest(
      new Request("https://shipshape.example/authorize"),
      env,
    );

    const html = await consent.text();
    const browser = cookieValue(consent, "__Host-shipshape-browser");
    const csrf = cookieValue(consent, "__Host-shipshape-csrf");
    expect(consent.headers.get("Content-Security-Policy")).not.toContain("form-action");
    expect(consent.headers.get("Content-Security-Policy")).toContain("default-src 'none'");

    const denied = await handleDefaultRequest(
      new Request("https://shipshape.example/authorize", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `__Host-shipshape-browser=${browser}; __Host-shipshape-csrf=${csrf}`,
        },
        body: new URLSearchParams({
          state: hiddenValue(html, "state"),
          csrf,
          decision: "deny",
        }),
      }),
      env,
    );

    const location = new URL(denied.headers.get("Location") ?? "");
    expect(denied.status).toBe(302);
    expect(location.href.split("?")[0]).toBe(redirectUri);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe(requestDetails.state);
  });

  it("rejects an authorization POST with a mismatched CSRF token", async () => {
    const env: OAuthEnv = {
      OAUTH_KV: memoryKv(),
      OAUTH_PROVIDER: {
        parseAuthRequest: vi.fn().mockResolvedValue(requestDetails),
        lookupClient: vi.fn().mockResolvedValue(client),
        completeAuthorization: () =>
          Promise.reject(new Error("Unexpected authorization completion")),
      } satisfies OAuthEnv["OAUTH_PROVIDER"],
      GITHUB_APP_CLIENT_ID: "Iv1.synthetic",
      GITHUB_APP_CLIENT_SECRET: "github-client-secret",
      OWNER_GITHUB_ID: "1001",
      COOKIE_ENCRYPTION_KEY: "cookie-signing-key",
      PUBLIC_ORIGIN: "https://shipshape.example",
    };

    const consent = await handleDefaultRequest(
      new Request("https://shipshape.example/authorize"),
      env,
    );

    const html = await consent.text();
    const browser = cookieValue(consent, "__Host-shipshape-browser");

    const response = await handleDefaultRequest(
      new Request("https://shipshape.example/authorize", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `__Host-shipshape-browser=${browser}; __Host-shipshape-csrf=wrong`,
        },
        body: new URLSearchParams({
          state: hiddenValue(html, "state"),
          csrf: hiddenValue(html, "csrf"),
          decision: "approve",
        }),
      }),
      env,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Set-Cookie")).toContain("__Host-shipshape-csrf=");
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("advertises GET and POST on authorize 405 responses", async () => {
    const env: OAuthEnv = {
      OAUTH_KV: memoryKv(),
      OAUTH_PROVIDER: {
        parseAuthRequest: vi.fn().mockResolvedValue(requestDetails),
        lookupClient: vi.fn().mockResolvedValue(client),
        completeAuthorization: () =>
          Promise.reject(new Error("Unexpected authorization completion")),
      } satisfies OAuthEnv["OAUTH_PROVIDER"],
      GITHUB_APP_CLIENT_ID: "Iv1.synthetic",
      GITHUB_APP_CLIENT_SECRET: "github-client-secret",
      OWNER_GITHUB_ID: "1001",
      COOKIE_ENCRYPTION_KEY: "cookie-signing-key",
      PUBLIC_ORIGIN: "https://shipshape.example",
    };

    const authorize = await handleDefaultRequest(
      new Request("https://shipshape.example/authorize", { method: "PUT" }),
      env,
    );

    expect(authorize.status).toBe(405);
    expect(authorize.headers.get("Allow")).toBe("GET, POST");

    const callback = await handleDefaultRequest(
      new Request("https://shipshape.example/callback", { method: "POST" }),
      env,
    );

    expect(callback.status).toBe(405);
    expect(callback.headers.get("Allow")).toBe("GET");
  });

  it("keeps the caller AbortSignal when applying the upstream timeout", async () => {
    const controller = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        fetchSignal = init?.signal ?? undefined;

        return Promise.resolve(new Response("ok"));
      }),
    );

    await fetchWithTimeout("https://github.com/login/oauth/access_token", {
      signal: controller.signal,
    });

    expect(fetchSignal).toBeDefined();
    expect(fetchSignal).not.toBe(controller.signal);
    expect(fetchSignal?.aborted).toBe(false);
    controller.abort();
    expect(fetchSignal?.aborted).toBe(true);
  });
});
