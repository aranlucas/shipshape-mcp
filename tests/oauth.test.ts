import type {
  AuthRequest,
  ClientInfo,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/workers-oauth-provider", () => ({
  AuthorizationError: class AuthorizationError extends Error {},
}));

import { handleDefaultRequest, type OAuthEnv } from "../src/oauth";

function memoryKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    delete: async (key: string) => {
      values.delete(key);
    },
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
  } as unknown as KVNamespace;
}

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
  if (!match?.[1]) throw new Error(`Missing ${name} field`);
  return match[1];
}

function cookieValue(response: Response, name: string): string {
  const header = response.headers.get("Set-Cookie") ?? "";
  const match = header.match(new RegExp(`${name}=([^;,]+)`, "u"));
  if (!match?.[1]) throw new Error(`Missing ${name} cookie`);
  return match[1];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OAuth proxy flow", () => {
  it("requires local consent, binds callback state, and grants only the MCP read scope", async () => {
    const completeAuthorization = vi.fn(async () => ({
      redirectTo: "https://client.example/callback?code=provider-code",
    }));
    const helpers = {
      parseAuthRequest: vi.fn(async () => requestDetails),
      lookupClient: vi.fn(async () => client),
      completeAuthorization,
    } as unknown as OAuthHelpers;
    const env: OAuthEnv = {
      OAUTH_KV: memoryKv(),
      OAUTH_PROVIDER: helpers,
      GITHUB_CLIENT_ID: "github-client-id",
      GITHUB_CLIENT_SECRET: "github-client-secret",
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
    expect(githubAuthorize.searchParams.get("scope")).toBe("read:user");
    expect(githubAuthorize.searchParams.get("redirect_uri")).toBe(
      "https://shipshape.example/callback",
    );

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "oauth_test_public_token",
          token_type: "bearer",
          scope: "read:user",
        }),
      )
      .mockResolvedValueOnce(Response.json({ login: "AranLucas" }));
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
        userId: "github-aranlucas",
        scope: ["mcp:read"],
        props: {
          accessToken: "oauth_test_public_token",
          login: "AranLucas",
        },
      }),
    );
  });

  it("rejects an authorization POST with a mismatched CSRF token", async () => {
    const env: OAuthEnv = {
      OAUTH_KV: memoryKv(),
      OAUTH_PROVIDER: {
        parseAuthRequest: vi.fn(async () => requestDetails),
        lookupClient: vi.fn(async () => client),
      } as unknown as OAuthHelpers,
      GITHUB_CLIENT_ID: "github-client-id",
      GITHUB_CLIENT_SECRET: "github-client-secret",
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
    expect(response.headers.get("Set-Cookie")).toContain(
      "__Host-shipshape-csrf=",
    );
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
});
