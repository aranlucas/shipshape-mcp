import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

vi.mock("agents/mcp/server", () => ({
  createMcpHandler: () => async () => new Response("MCP"),
}));
vi.mock("../src/mcp", () => ({ createShipshapeServer: vi.fn() }));

import provider from "../src/index";
import { MCP_RESOURCE, MCP_SCOPE } from "../src/config";
import type { OAuthEnv } from "../src/oauth";

function environment(): OAuthEnv {
  const values = new Map<string, string>();
  return {
    OAUTH_KV: {
      delete: async (key: string) => {
        values.delete(key);
      },
      get: async (key: string, options?: { type?: string } | string) => {
        const value = values.get(key) ?? null;
        const type = typeof options === "string" ? options : options?.type;
        return value !== null && type === "json" ? JSON.parse(value) : value;
      },
      put: async (key: string, value: string) => {
        values.set(key, value);
      },
    } as unknown as KVNamespace,
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    COOKIE_ENCRYPTION_KEY: "cookie-signing-key",
  } as OAuthEnv;
}

const context = { waitUntil: vi.fn() } as unknown as ExecutionContext;

function register(redirectUris: string[]) {
  return provider.fetch(
    new Request(new URL("/oauth/register", MCP_RESOURCE), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "MCP client",
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
      }),
    }),
    environment(),
    context,
  );
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
    const response = await provider.fetch(
      new Request(MCP_RESOURCE),
      environment(),
      context,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      `scope="${MCP_SCOPE}"`,
    );
  });
});
