import type { AppEnv } from "./env";
import type { OAuthStateStore } from "./oauth-security";

export const CALLBACK_PATH = "/callback/web";

export type OAuthEnv = Pick<
  AppEnv,
  "BETTER_AUTH_ISSUER" | "BETTER_AUTH_JWKS_URL" | "OWNER_GITHUB_ID" | "ASSETS" | "PUBLIC_ORIGIN"
> & { OAUTH_KV: OAuthStateStore };

export function callbackUrl(request: Request, env: OAuthEnv, path: string = CALLBACK_PATH): URL {
  const requestOrigin = new URL(request.url).origin;
  const configured = env.PUBLIC_ORIGIN?.trim();

  const configuredOrigin =
    configured !== undefined && configured.length > 0 ? configured : requestOrigin;

  const origin = new URL(configuredOrigin);

  if (
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" &&
        (origin.hostname === "localhost" || origin.hostname === "127.0.0.1")
      ))
  ) {
    throw new Error("Invalid public origin configuration");
  }

  return new URL(path, origin);
}
