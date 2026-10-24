import * as oauth from "oauth4webapi";
import { z } from "zod";

import { authSettings, validateAccessToken } from "../auth/better-auth";
import { MCP_SCOPE } from "../config";
import { CALLBACK_PATH, callbackUrl, type OAuthEnv } from "../oauth";
import { getCookie } from "../oauth-security";
import { LOGIN_COOKIE_NAME, consumeLoginState, createLoginState } from "./session";

const ClientSchema = z.object({ client_id: z.string().min(1).max(2048) });

function authorizationServer(env: OAuthEnv): oauth.AuthorizationServer {
  const { issuer, jwksUrl } = authSettings(env);

  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth2/authorize`,
    token_endpoint: `${issuer}/oauth2/token`,
    registration_endpoint: `${issuer}/oauth2/register`,
    jwks_uri: jwksUrl,
    authorization_response_iss_parameter_supported: true,
  };
}

/** Register a public PKCE client once per exact callback, including preview origins. */
async function dashboardClient(env: OAuthEnv, redirectUri: string, resource: string) {
  const key = `web:oauth-client:${authSettings(env).issuer}:${redirectUri}`;
  const cached = await env.OAUTH_KV.get(key);

  if (cached) {
    const parsed = ClientSchema.safeParse(
      (() => {
        try {
          const value: unknown = JSON.parse(cached);

          return value;
        } catch {
          return null;
        }
      })(),
    );

    if (parsed.success) {
      return parsed.data.client_id;
    }
  }

  const server = authorizationServer(env);

  const response = await fetch(new URL(`${server.issuer}/oauth2/register`), {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(8_000),
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Shipshape dashboard",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: MCP_SCOPE,
      resources: [resource],
    }),
  });

  if (!response.ok) {
    throw new Error("Dashboard client registration unavailable");
  }

  const client = ClientSchema.parse(await response.json());
  await env.OAUTH_KV.put(key, JSON.stringify(client), { expirationTtl: 24 * 60 * 60 });

  return client.client_id;
}

export async function startDashboardLogin(request: Request, env: OAuthEnv) {
  const redirectUri = callbackUrl(request, env, CALLBACK_PATH).href;
  const resource = callbackUrl(request, env, "/mcp").href;
  const clientId = await dashboardClient(env, redirectUri, resource);
  const codeVerifier = oauth.generateRandomCodeVerifier();

  const { state, browser } = await createLoginState(env.OAUTH_KV, {
    clientId,
    codeVerifier,
    redirectUri,
  });

  const authorize = new URL(`${authSettings(env).issuer}/oauth2/authorize`);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", MCP_SCOPE);
  authorize.searchParams.set("resource", resource);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set(
    "code_challenge",
    await oauth.calculatePKCECodeChallenge(codeVerifier),
  );

  return { authorize, browser };
}

export async function completeDashboardLogin(request: Request, env: OAuthEnv) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const login = await consumeLoginState(env.OAUTH_KV, state, getCookie(request, LOGIN_COOKIE_NAME));

  if (!login || !state || login.redirectUri !== callbackUrl(request, env, CALLBACK_PATH).href) {
    return null;
  }

  const server = authorizationServer(env);
  const client: oauth.Client = { client_id: login.clientId, token_endpoint_auth_method: "none" };
  const resource = callbackUrl(request, env, "/mcp").href;
  const parameters = oauth.validateAuthResponse(server, client, url, state);

  const response = await oauth.authorizationCodeGrantRequest(
    server,
    client,
    oauth.None(),
    parameters,
    login.redirectUri,
    login.codeVerifier,
    {
      additionalParameters: { resource },
      signal: AbortSignal.timeout(8_000),
      [oauth.customFetch]: (input, init) => fetch(input, { ...init, redirect: "manual" }),
    },
  );

  const tokens = await oauth.processAuthorizationCodeResponse(server, client, response);

  if (tokens.token_type.toLowerCase() !== "bearer") {
    return null;
  }

  const verified = await validateAccessToken(env, resource, tokens.access_token);

  return verified?.clientId === login.clientId ? verified : null;
}
