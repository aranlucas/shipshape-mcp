import { exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MCP_RESOURCE, MCP_SCOPE } from "../../src/config";
import { repository } from "../helpers/github-fixtures";

const outbound: string[] = [];

const upstream = new Map<
  string,
  { method: string; payload: string; token?: string }
>();

// The Worker runs in the test isolate, so its outbound fetches hit this stub.
beforeAll(async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const fixture = upstream.get(request.url);

    if (fixture) {
      expect(request.method).toBe(fixture.method);

      if (fixture.token)
        expect(request.headers.get("Authorization")).toMatch(
          new RegExp(`^(token|bearer) ${fixture.token}$`, "i"),
        );
      upstream.delete(request.url);

      return new Response(fixture.payload, {
        headers: { "content-type": "application/json" },
      });
    }

    outbound.push(request.url);
    throw new Error(`Unexpected Worker outbound request: ${request.url}`);
  });

  // The first request loads the whole Worker module graph; keep that out of test timeouts.
  await dispatch(MCP_RESOURCE);
}, 30_000);

afterAll(() => {
  vi.restoreAllMocks();
  expect(outbound).toEqual([]);
  expect(upstream.size).toBe(0);
});

// In-isolate requests carry no Host header; reproduce the edge request authority.
// A dedicated test header permits checking the Host rejection path.
function dispatch(input: string | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Host", headers.get("X-Fixture-Host") ?? new URL(input).host);
  headers.delete("X-Fixture-Host");

  return exports.default.fetch(
    new Request(input, { ...init, headers, redirect: "manual" }),
  );
}

function register(redirectUris: string[]) {
  return dispatch(new URL("/oauth/register", MCP_RESOURCE), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "MCP client",
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
    }),
  });
}

describe("OAuth provider redirect policy", () => {
  it.each([
    ["https://client.example/callback"],
    ["http://127.0.0.1:49152/callback"],
    ["claude://oauth/callback"],
    [
      "cursor://anysphere.cursor-mcp/oauth/callback",
      "http://127.0.0.1:49152/callback",
    ],
  ])("keeps supported client callbacks: %j", async (...redirectUris) => {
    const response = await register(redirectUris);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      redirect_uris: redirectUris,
    });
  });

  it.each([
    "http://remote.example/callback",
    "javascript:alert(1)",
    "https://client.example/callback#fragment",
    "https://user:password@client.example/callback",
  ])("rejects unsafe client callbacks: %s", async (redirectUri) => {
    const response = await register([redirectUri]);
    expect(response.status).toBe(400);
  });

  it("advertises the MCP scope on the unauthenticated challenge", async () => {
    const response = await dispatch(MCP_RESOURCE);

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      `scope="${MCP_SCOPE}"`,
    );
  });
  it("uses the real provider, KV, GitHub OAuth adapter and MCP handler together", async () => {
    const registration = await register(["https://client.example/callback"]);

    const { client_id: clientId } = z
      .object({ client_id: z.string() })
      .parse(await registration.json());

    const verifier =
      "synthetic-pkce-verifier-which-is-at-least-forty-three-characters";

    const challenge = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ).toString("base64url");

    const authorizeUrl = new URL("/authorize", MCP_RESOURCE);
    authorizeUrl.search = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: "https://client.example/callback",
      scope: MCP_SCOPE,
      state: "synthetic-client-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: MCP_RESOURCE,
    }).toString();
    const consent = await dispatch(authorizeUrl);
    expect(consent.status).toBe(200);
    const html = await consent.text();
    const cookies = consent.headers.get("Set-Cookie") ?? "";
    const browser = captured(cookies, /__Host-shipshape-browser=([^;,]+)/);
    const csrf = captured(html, /name="csrf" value="([^"]+)"/);
    const state = captured(html, /name="state" value="([^"]+)"/);

    const approved = await dispatch(new URL("/authorize", MCP_RESOURCE), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        Cookie: `__Host-shipshape-browser=${browser}; __Host-shipshape-csrf=${csrf}`,
      },
      body: new URLSearchParams({
        state,
        csrf,
        decision: "approve",
      }).toString(),
    });

    expect(approved.status).toBe(302);
    const github = new URL(approved.headers.get("Location") ?? "");
    expect(github.origin).toBe("https://github.com");
    expect(github.searchParams.get("scope")).toBe("read:user");
    upstream.set("https://github.com/login/oauth/access_token", {
      method: "POST",
      payload: JSON.stringify({
        access_token: "synthetic-github-token",
        token_type: "bearer",
        scope: "read:user",
      }),
    });
    upstream.set("https://api.github.com/user", {
      method: "GET",
      payload: JSON.stringify({ login: "octo" }),
    });
    const callback = new URL("/callback", MCP_RESOURCE);
    callback.search = new URLSearchParams({
      code: "synthetic-github-code",
      state: github.searchParams.get("state") ?? "",
    }).toString();

    const completed = await dispatch(callback, {
      headers: { Cookie: `__Host-shipshape-browser=${browser}` },
    });

    expect(completed.status).toBe(302);
    const redirect = new URL(completed.headers.get("Location") ?? "");
    expect(redirect.origin).toBe("https://client.example");
    expect(redirect.searchParams.get("state")).toBe("synthetic-client-state");
    expect(redirect.searchParams.has("error")).toBe(false);
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await dispatch(new URL("/oauth/token", MCP_RESOURCE), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: "https://client.example/callback",
        code: code ?? "",
        code_verifier: verifier,
        resource: MCP_RESOURCE,
      }).toString(),
    });

    expect(token.status).toBe(200);

    const access = z
      .object({ access_token: z.string(), scope: z.string() })
      .parse(await token.json());

    expect(access.scope).toBe(MCP_SCOPE);

    const listing = await dispatch(MCP_RESOURCE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${access.access_token}`,
        "MCP-Protocol-Version": "2025-03-26",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    const listingBody = await listing.text();
    expect(listing.status, listingBody).toBe(200);
    expect(listingBody).toContain('"standards_audit"');
    expect(upstream.size).toBe(0);
    upstream.set("https://api.github.com/repos/octo/demo", {
      method: "GET",
      token: "synthetic-github-token",
      payload: JSON.stringify({ ...repository, private: true }),
    });

    const privateAudit = await dispatch(MCP_RESOURCE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${access.access_token}`,
        "MCP-Protocol-Version": "2025-03-26",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "standards_audit",
          arguments: { owner: "octo", repo: "demo" },
        },
      }),
    });

    expect(privateAudit.status).toBe(200);
    expect(await privateAudit.text()).toContain(
      "Shipshape only inspects public repositories.",
    );
    expect(upstream.size).toBe(0);

    const invalidHost = await dispatch(MCP_RESOURCE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${access.access_token}`,
        "MCP-Protocol-Version": "2025-03-26",
        "X-Fixture-Host": "attacker.example",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });

    expect(invalidHost.status).toBe(403);
    expect(await invalidHost.text()).toContain("Invalid Host");
  });

  it("keeps untrusted authorization redirects local with the actual SDK error class", async () => {
    const registration = await register(["https://client.example/callback"]);

    const { client_id: clientId } = z
      .object({ client_id: z.string() })
      .parse(await registration.json());

    const url = new URL("/authorize", MCP_RESOURCE);
    url.search = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: "https://attacker.example/callback",
    }).toString();
    const response = await dispatch(url);
    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
  });
});

function captured(text: string, pattern: RegExp): string {
  const value = pattern.exec(text)?.[1];

  if (!value) throw new Error(`Missing expected OAuth field: ${pattern}`);

  return value;
}
