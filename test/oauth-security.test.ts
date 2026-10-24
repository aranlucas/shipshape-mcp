import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { accessTokenOptions, authSettings, validateAccessToken } from "@/auth/better-auth";
import {
  appendSetCookie,
  clearCookie,
  getCookie,
  makeCookie,
  securityHeaders,
} from "@/oauth-security";
import {
  AUTH_RESOURCE,
  AUTH_SCOPE,
  authTokenFixture,
  type AuthTokenFixture,
} from "@test/helpers/auth-token";

let auth: AuthTokenFixture;

beforeAll(async () => {
  auth = await authTokenFixture();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function environment(fixture = auth) {
  return { BETTER_AUTH_ISSUER: fixture.issuer, BETTER_AUTH_JWKS_URL: fixture.jwksUrl };
}

function mockJwks(fixture = auth) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
    const url = input instanceof Request ? input.url : String(input);
    expect(url).toBe(fixture.jwksUrl);

    return Promise.resolve(Response.json(fixture.jwks));
  });

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

describe("central Auth access tokens", () => {
  it.each(["RS256", "ES256", "EdDSA"])(
    "verifies a signed %s access token and maps linked GitHub identity",
    async (algorithm) => {
      const fixture = await authTokenFixture(algorithm);
      mockJwks(fixture);
      const expiresAt = Math.floor(Date.now() / 1_000) + 180;

      expect(
        await validateAccessToken(
          environment(fixture),
          AUTH_RESOURCE,
          await fixture.sign({ exp: expiresAt }),
        ),
      ).toEqual({
        identity: { login: "aranlucas", userId: 1001 },
        subject: "auth-user-1",
        clientId: "shipshape-test-client",
        expiresAt,
        scopes: [AUTH_SCOPE],
      });
    },
  );

  it("pins the issuer, exact resource, access token type, algorithms and scope", () => {
    expect(accessTokenOptions(environment(), AUTH_RESOURCE)).toMatchObject({
      jwksUrl: auth.jwksUrl,
      verifyOptions: {
        issuer: auth.issuer,
        audience: AUTH_RESOURCE,
        algorithms: ["RS256", "ES256", "EdDSA"],
        typ: "at+jwt",
        requiredClaims: ["sub", "client_id", "scope", "iat", "exp"],
      },
      requiredScopes: [AUTH_SCOPE],
    });
  });

  it("accepts an audience array containing the exact resource and rejects arrays without it", async () => {
    mockJwks();

    expect(
      await validateAccessToken(
        environment(),
        AUTH_RESOURCE,
        await auth.sign({
          aud: [AUTH_RESOURCE, `${auth.issuer}/userinfo`],
        }),
      ),
    ).toMatchObject({ identity: { login: "aranlucas", userId: 1001 } });

    await expect(
      validateAccessToken(
        environment(),
        AUTH_RESOURCE,
        await auth.sign({
          aud: ["https://other.example/mcp", `${auth.issuer}/userinfo`],
        }),
      ),
    ).rejects.toThrow(/token|scope|DPoP|claim|key|aud/iu);
  });

  it.each([
    ["wrong issuer", { iss: "https://attacker.example" }],
    ["wrong audience", { aud: "https://other.example/mcp" }],
    ["resource origin instead of exact MCP audience", { aud: "https://shipshape.example" }],
    ["audience with a trailing slash", { aud: `${AUTH_RESOURCE}/` }],
    ["missing audience", { aud: undefined }],
    ["missing scope", { scope: undefined }],
    ["unrelated scope", { scope: "other:access" }],
    ["scope substring", { scope: "shipshape:access:admin" }],
    ["expired token", { exp: 1 }],
    ["missing expiration", { exp: undefined }],
    ["missing issued-at", { iat: undefined }],
    ["missing subject", { sub: undefined }],
    ["missing client id", { client_id: undefined }],
    ["proof-bound access token", { cnf: { jkt: "proof-key-thumbprint" } }],
  ])("rejects a token with %s", async (_label, claims) => {
    mockJwks();

    await expect(
      validateAccessToken(environment(), AUTH_RESOURCE, await auth.sign(claims)),
    ).rejects.toThrow(/token|scope|DPoP|claim|key|aud/iu);
  });

  it.each(["JWT", "id+jwt", undefined])("rejects a token with type %j", async (typ) => {
    mockJwks();

    await expect(
      validateAccessToken(environment(), AUTH_RESOURCE, await auth.sign({}, { typ })),
    ).rejects.toThrow(/token|scope|DPoP|claim|key|aud/iu);
  });

  it("rejects a signature from an untrusted key", async () => {
    const attacker = await authTokenFixture();
    mockJwks();

    await expect(
      validateAccessToken(environment(), AUTH_RESOURCE, await attacker.sign()),
    ).rejects.toThrow(/token|scope|DPoP|claim|key|aud/iu);
  });

  it.each([
    ["unlinked account", { github_id: undefined, github_login: undefined }],
    ["numeric rather than string GitHub id", { github_id: 1001 }],
    ["zero GitHub id", { github_id: "0" }],
    ["negative GitHub id", { github_id: "-1001" }],
    ["fractional GitHub id", { github_id: "1001.5" }],
    ["unsafe GitHub id", { github_id: "9007199254740992" }],
    ["empty GitHub login", { github_login: "" }],
    ["malformed GitHub login", { github_login: "<script>" }],
    ["empty subject", { sub: "" }],
    ["empty client id", { client_id: "" }],
    ["future issued-at", { iat: 4_000_000_000 }],
  ])("does not map identity for %s", async (_label, claims) => {
    mockJwks();

    expect(
      await validateAccessToken(environment(), AUTH_RESOURCE, await auth.sign(claims)),
    ).toBeNull();
  });

  it.each([
    "http://auth.example",
    "https://user:password@auth.example",
    "https://auth.example?x=1",
    "https://auth.example#fragment",
  ])("rejects unsafe Auth URLs %s", (url) => {
    expect(() => authSettings({ ...environment(), BETTER_AUTH_ISSUER: url })).toThrow(/Invalid/iu);
    expect(() => authSettings({ ...environment(), BETTER_AUTH_JWKS_URL: url })).toThrow(
      /Invalid/iu,
    );
  });
});

describe("browser security helpers", () => {
  it("preserves multiple secure cookies and emits hardening headers", () => {
    const headers = securityHeaders();
    appendSetCookie(headers, makeCookie("__Host-one", "first", { maxAge: 300 }));
    appendSetCookie(headers, clearCookie("__Host-two"));

    expect(headers.get("Set-Cookie")).toContain(
      "__Host-one=first; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300",
    );
    expect(headers.get("Set-Cookie")).toContain(
      "__Host-two=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    );
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'",
    );
  });

  it("does not read oversized browser cookie values", () => {
    const request = new Request("https://shipshape.example", {
      headers: { Cookie: `session=${"a".repeat(6_001)}` },
    });

    expect(getCookie(request, "session")).toBeNull();
  });
});
