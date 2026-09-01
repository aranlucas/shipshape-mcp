import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it } from "vitest";

import {
  type ApprovedClientRecord,
  type AuthorizationStateRecord,
  appendSetCookie,
  consumeBrowserBoundState,
  createSignedApprovalCookie,
  makeCookie,
  parseSignedApprovalCookie,
  putBrowserBoundState,
  sanitizeClientMetadata,
  safeHttpUrl,
  securityHeaders,
} from "../src/oauth-security";

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

function authRequest(): AuthRequest {
  return {
    clientId: "client-1",
    codeChallenge: "challenge",
    codeChallengeMethod: "S256",
    redirectUri: "https://client.example/callback",
    responseType: "code",
    scope: ["portfolio:read"],
    state: "client-state",
  };
}

describe("OAuth security primitives", () => {
  it("binds state to the browser and consumes it only once", async () => {
    const kv = memoryKv();
    const record: AuthorizationStateRecord = {
      browserBinding: "",
      createdAt: Date.now(),
      kind: "authorization",
      oauthRequest: authRequest(),
    };

    await putBrowserBoundState(kv, "state-token-123456", record, "browser-a");
    expect(
      await consumeBrowserBoundState(kv, "state-token-123456", "browser-b"),
    ).toBeNull();
    expect(
      await consumeBrowserBoundState(kv, "state-token-123456", "browser-a"),
    ).toMatchObject({
      kind: record.kind,
      createdAt: record.createdAt,
      oauthRequest: record.oauthRequest,
    });
    expect(
      await consumeBrowserBoundState(kv, "state-token-123456", "browser-a"),
    ).toBeNull();
  });

  it("signs approved clients and rejects tampering and expiry", async () => {
    const record: ApprovedClientRecord = {
      clientId: "client-1",
      expiresAt: Date.now() + 60_000,
      redirectUri: "https://client.example/callback",
      scope: "portfolio:read",
    };
    const cookie = await createSignedApprovalCookie(
      record,
      "test-cookie-secret",
    );

    expect(
      await parseSignedApprovalCookie(cookie, "test-cookie-secret"),
    ).toEqual(record);
    expect(
      await parseSignedApprovalCookie(
        `${cookie}tampered`,
        "test-cookie-secret",
      ),
    ).toBeNull();
    expect(
      await parseSignedApprovalCookie(
        cookie,
        "test-cookie-secret",
        record.expiresAt + 1,
      ),
    ).toBeNull();
  });

  it("escapes metadata and allows only HTTP(S) links", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeHttpUrl("data:text/html,unsafe")).toBeUndefined();
    expect(safeHttpUrl("https://client.example/app")).toBe(
      "https://client.example/app",
    );

    const metadata = sanitizeClientMetadata({
      clientId: "client-1",
      clientName: '<script>alert("x")</script>',
      contacts: ["owner@example.com"],
      redirectUris: ["javascript:alert(1)", "https://client.example/callback"],
      tokenEndpointAuthMethod: "none",
    });
    expect(metadata.clientName).toContain("<script>");
    expect(metadata.redirectUris).toEqual(["https://client.example/callback"]);
  });

  it("preserves multiple Set-Cookie headers and emits hardening headers", () => {
    const headers = securityHeaders();
    appendSetCookie(headers, makeCookie("__Host-one", "first"));
    appendSetCookie(headers, makeCookie("__Host-two", "second"));

    expect(headers.get("Set-Cookie")).toContain("__Host-one=first");
    expect(headers.get("Set-Cookie")).toContain("__Host-two=second");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
