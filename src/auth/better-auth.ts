import { verifyBearerToken } from "better-auth/oauth2";
import type { JWTPayload } from "jose";
import { z } from "zod";

import { MCP_SCOPE } from "../config";
import type { AppEnv } from "../env";
import { GitHubOwnerInputSchema } from "../github/schemas";

type AuthBindings = Pick<AppEnv, "BETTER_AUTH_ISSUER" | "BETTER_AUTH_JWKS_URL">;

const HttpsUrlSchema = z.url().refine((value) => {
  const url = new URL(value);

  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
});

const AuthSettingsSchema = z.object({
  BETTER_AUTH_ISSUER: HttpsUrlSchema,
  BETTER_AUTH_JWKS_URL: HttpsUrlSchema,
});

export function authSettings(env: AuthBindings) {
  const settings = AuthSettingsSchema.parse(env);

  return { issuer: settings.BETTER_AUTH_ISSUER, jwksUrl: settings.BETTER_AUTH_JWKS_URL };
}

export function accessTokenOptions(env: AuthBindings, resource: string) {
  const settings = authSettings(env);

  return {
    jwksUrl: settings.jwksUrl,
    verifyOptions: {
      issuer: settings.issuer,
      audience: resource,
      algorithms: ["RS256", "ES256", "EdDSA"],
      typ: "at+jwt",
      requiredClaims: ["sub", "client_id", "scope", "iat", "exp"],
    },
    requiredScopes: [MCP_SCOPE],
  };
}

const AccessClaimsSchema = z.object({
  sub: z.string().min(1).max(256),
  client_id: z.string().min(1).max(2048),
  scope: z.string().max(2048),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  github_id: z
    .string()
    .regex(/^[1-9]\d*$/u)
    .transform(Number)
    .pipe(z.number().int().positive().safe()),
  github_login: GitHubOwnerInputSchema,
});

/** Only consume identity claims after the OAuth library has verified the JWT. */
export function accessIdentity(payload: JWTPayload) {
  const parsed = AccessClaimsSchema.safeParse(payload);

  if (!parsed.success || payload.cnf !== undefined) {
    return null;
  }

  const claims = parsed.data;
  const now = Math.floor(Date.now() / 1000);
  const scopes = claims.scope.split(" ");

  if (claims.iat > now + 30 || claims.exp <= now || !scopes.includes(MCP_SCOPE)) {
    return null;
  }

  return {
    identity: { login: claims.github_login, userId: claims.github_id },
    subject: claims.sub,
    clientId: claims.client_id,
    expiresAt: claims.exp,
    scopes,
  };
}

export async function validateAccessToken(env: AuthBindings, resource: string, token: string) {
  const payload = await verifyBearerToken(token, accessTokenOptions(env, resource));

  return accessIdentity(payload);
}
