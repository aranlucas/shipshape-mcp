import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";

export const AUTH_ISSUER = "https://auth.aranlucas.workers.dev";

export const AUTH_RESOURCE = "https://shipshape.example/mcp";

export const AUTH_SCOPE = "shipshape:access";

interface TokenHeader {
  typ?: string;
}

/** Real signatures and public JWKS keep resource-server tests independent of verifier mocks. */
export async function authTokenFixture(algorithm = "RS256") {
  const { privateKey, publicKey } = await generateKeyPair(algorithm, { extractable: true });
  const kid = crypto.randomUUID();
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, alg: algorithm, use: "sig" }] };
  const jwksUrl = `${AUTH_ISSUER}/test-jwks/${kid}`;

  return {
    issuer: AUTH_ISSUER,
    jwksUrl,
    jwks,
    sign(claims: JWTPayload = {}, header: TokenHeader = {}) {
      const now = Math.floor(Date.now() / 1_000);

      return new SignJWT({
        iss: AUTH_ISSUER,
        aud: AUTH_RESOURCE,
        sub: "auth-user-1",
        client_id: "shipshape-test-client",
        github_id: "1001",
        github_login: "aranlucas",
        scope: AUTH_SCOPE,
        iat: now,
        exp: now + 300,
        ...claims,
      })
        .setProtectedHeader({ alg: algorithm, kid, typ: "at+jwt", ...header })
        .sign(privateKey);
    },
  };
}

export type AuthTokenFixture = Awaited<ReturnType<typeof authTokenFixture>>;
