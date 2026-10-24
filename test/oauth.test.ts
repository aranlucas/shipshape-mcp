import { describe, expect, it } from "vitest";

import { callbackUrl, type OAuthEnv } from "@/oauth";
import { memoryKv } from "@test/helpers/oauth-state";
import { AUTH_ISSUER } from "@test/helpers/auth-token";

function environment(publicOrigin?: string): OAuthEnv {
  return {
    OAUTH_KV: memoryKv(),
    OWNER_GITHUB_ID: "1001",
    BETTER_AUTH_ISSUER: AUTH_ISSUER,
    BETTER_AUTH_JWKS_URL: `${AUTH_ISSUER}/api/auth/jwks`,
    PUBLIC_ORIGIN: publicOrigin,
  };
}

describe("browser OAuth callback origin", () => {
  const request = new Request("https://preview.example/app/login", {
    headers: {
      Host: "attacker.example",
      "X-Forwarded-Host": "attacker.example",
      "X-Forwarded-Proto": "http",
    },
  });

  it("uses the configured public origin and the website callback", () => {
    expect(callbackUrl(request, environment(" https://shipshape.example/ ")).href).toBe(
      "https://shipshape.example/callback/web",
    );
    expect(callbackUrl(request, environment("https://shipshape.example"), "/mcp").href).toBe(
      "https://shipshape.example/mcp",
    );
  });

  it.each([undefined, "", "   "])(
    "uses the preview URL authority when the configured origin is %j",
    (origin) => {
      expect(callbackUrl(request, environment(origin)).href).toBe(
        "https://preview.example/callback/web",
      );
    },
  );

  it.each(["http://localhost:5173", "http://127.0.0.1:5173"])(
    "supports the local development origin %s",
    (origin) => {
      expect(callbackUrl(request, environment(origin)).href).toBe(`${origin}/callback/web`);
    },
  );

  it.each([
    "http://remote.example",
    "https://user:password@shipshape.example",
    "https://shipshape.example/path",
    "https://shipshape.example?origin=attacker",
    "https://shipshape.example#fragment",
    "javascript:alert(1)",
  ])("rejects an unsafe public origin %s", (origin) => {
    expect(() => callbackUrl(request, environment(origin))).toThrow(
      "Invalid public origin configuration",
    );
  });
});
