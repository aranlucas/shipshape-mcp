import { z } from "zod";
import { GITHUB_SCOPE } from "../config";
import { collectSettingsDrift } from "../drift/collect";
import { parseDriftPolicy } from "../drift/policy";
import {
  GitHubInputError,
  PrivateRepositoryError,
  createGitHubOctokit,
} from "../github/client";
import { GitHubOwnerInputSchema } from "../github/schemas";
import { ConfigValueSchema, type ConfigValue } from "../standards/config-value";
import { methodNotAllowed, notFoundResponse } from "../landing";
import {
  appendSetCookie,
  clearCookie,
  getCookie,
  makeCookie,
  securityHeaders,
} from "../oauth-security";
import { callbackUrl, completeGitHubLogin, type OAuthEnv } from "../oauth";
import { APP_SCRIPT } from "./script";
import { renderAppPage, renderSignInPage } from "./page";
import {
  LOGIN_COOKIE_NAME,
  LOGIN_STATE_TTL_SECONDS,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  consumeLoginState,
  createLoginState,
  createSession,
  deleteSession,
  readSession,
  type WebSession,
} from "./session";

export const APP_PATH = "/app" as const;

export const WEB_CALLBACK_PATH = "/callback/web" as const;

export const APP_SCRIPT_PATH = "/app/app.js" as const;

const MAX_POLICY_LENGTH = 64_000;

const APP_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const DriftRequestSchema = z
  .object({
    owner: GitHubOwnerInputSchema,
    policy: z.string().min(1).max(MAX_POLICY_LENGTH),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();

const RulesRequestSchema = z
  .object({ policy: z.string().min(1).max(MAX_POLICY_LENGTH) })
  .strict();

export function isWebPath(pathname: string): boolean {
  return (
    pathname === APP_PATH ||
    pathname.startsWith(`${APP_PATH}/`) ||
    pathname === WEB_CALLBACK_PATH
  );
}

function appHeaders(contentType: string): Headers {
  const headers = securityHeaders();
  headers.set("Content-Security-Policy", APP_CONTENT_SECURITY_POLICY);
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "no-store");

  return headers;
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: appHeaders("text/html; charset=utf-8"),
  });
}

function json(payload: ConfigValue, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: appHeaders("application/json; charset=utf-8"),
  });
}

function jsonError(status: number, message: string): Response {
  return json({ error: message }, status);
}

function redirect(location: string, status: 302 | 303 = 302): Response {
  const headers = securityHeaders();
  headers.set("Location", location);
  headers.set("Cache-Control", "no-store");

  return new Response(null, { status, headers });
}

function publicOrigin(request: Request, env: OAuthEnv): string {
  return callbackUrl(request, env, "/").origin;
}

/**
 * State-changing requests must come from this origin.  Session cookies are
 * SameSite=Lax as well, and JSON bodies cannot be sent cross-origin without a
 * CORS preflight this Worker never answers.
 */
function sameOrigin(request: Request, env: OAuthEnv): boolean {
  const site = request.headers.get("Sec-Fetch-Site");

  return (
    request.headers.get("Origin") === publicOrigin(request, env) &&
    (site === null || site === "same-origin")
  );
}

async function readJson(request: Request): Promise<ConfigValue> {
  if (
    !(request.headers.get("Content-Type") ?? "")
      .toLowerCase()
      .startsWith("application/json")
  )
    throw new GitHubInputError("Send a JSON request body.");

  const text = await request.text();

  if (text.length > MAX_POLICY_LENGTH + 1_000)
    throw new GitHubInputError("The request body is too large.");

  try {
    return ConfigValueSchema.parse(JSON.parse(text));
  } catch {
    throw new GitHubInputError("Send a valid JSON request body.");
  }
}

function errorMessage(cause: unknown) {
  const status = z.object({ status: z.number() }).safeParse(cause).data?.status;

  if (cause instanceof GitHubInputError)
    return { status: 400, message: cause.message };

  if (cause instanceof z.ZodError)
    return {
      status: 400,
      message: cause.issues[0]?.message ?? "Check the request fields.",
    };

  if (cause instanceof PrivateRepositoryError)
    return {
      status: 400,
      message: "Shipshape only inspects public repositories.",
    };

  if (status === 401)
    return {
      status: 401,
      message: "Your GitHub session expired. Sign in again.",
    };

  if (status === 404)
    return { status: 404, message: "That GitHub owner was not found." };

  if (status === 403)
    return {
      status: 502,
      message: "GitHub denied the request or the rate limit was reached.",
    };

  return {
    status: 502,
    message: "GitHub could not be reached right now. Try again shortly.",
  };
}

function rulesKey(session: WebSession): string {
  return `web:rules:${session.login.toLowerCase()}`;
}

async function startLogin(request: Request, env: OAuthEnv): Promise<Response> {
  const { state, browser } = await createLoginState(env.OAUTH_KV);
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);

  authorize.searchParams.set(
    "redirect_uri",
    callbackUrl(request, env, WEB_CALLBACK_PATH).toString(),
  );

  authorize.searchParams.set("scope", GITHUB_SCOPE);
  authorize.searchParams.set("state", state);

  const response = redirect(authorize.toString());

  appendSetCookie(
    response.headers,
    makeCookie(LOGIN_COOKIE_NAME, browser, {
      maxAge: LOGIN_STATE_TTL_SECONDS,
    }),
  );

  return response;
}

async function finishLogin(request: Request, env: OAuthEnv): Promise<Response> {
  const url = new URL(request.url);

  const valid = await consumeLoginState(
    env.OAUTH_KV,
    url.searchParams.get("state"),
    getCookie(request, LOGIN_COOKIE_NAME),
  );

  const login = valid
    ? await completeGitHubLogin(request, env, WEB_CALLBACK_PATH)
    : null;

  if (!login) {
    const response = html(
      renderSignInPage(
        "GitHub sign-in could not be completed. Please try again.",
      ),
      400,
    );

    appendSetCookie(response.headers, clearCookie(LOGIN_COOKIE_NAME));

    return response;
  }

  const secret = await createSession(env.OAUTH_KV, login);
  const response = redirect(APP_PATH);
  appendSetCookie(response.headers, clearCookie(LOGIN_COOKIE_NAME));

  appendSetCookie(
    response.headers,
    makeCookie(SESSION_COOKIE_NAME, secret, { maxAge: SESSION_TTL_SECONDS }),
  );

  return response;
}

async function driftApi(
  request: Request,
  session: WebSession,
): Promise<Response> {
  const input = DriftRequestSchema.parse(await readJson(request));
  const policy = parseDriftPolicy(input.policy);

  const report = await collectSettingsDrift(
    createGitHubOctokit(session.accessToken),
    input.owner,
    policy,
    { limit: input.limit, source: { kind: "inline" } },
  );

  return json(ConfigValueSchema.parse(JSON.parse(JSON.stringify(report))));
}

async function rulesApi(
  request: Request,
  env: OAuthEnv,
  session: WebSession,
): Promise<Response> {
  if (request.method === "GET")
    return json({ policy: await env.OAUTH_KV.get(rulesKey(session)) });

  const { policy } = RulesRequestSchema.parse(await readJson(request));
  parseDriftPolicy(policy);
  await env.OAUTH_KV.put(rulesKey(session), policy);

  return json({ saved: true });
}

export async function webHandler(
  request: Request,
  env: OAuthEnv,
): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === APP_SCRIPT_PATH) {
    if (request.method !== "GET") return methodNotAllowed();
    const headers = appHeaders("text/javascript; charset=utf-8");
    headers.set("Cache-Control", "public, max-age=300");

    return new Response(APP_SCRIPT, { status: 200, headers });
  }

  if (pathname === "/app/login") {
    if (request.method !== "GET") return methodNotAllowed();

    return startLogin(request, env);
  }

  if (pathname === WEB_CALLBACK_PATH) {
    if (request.method !== "GET") return methodNotAllowed();

    return finishLogin(request, env);
  }

  const session = await readSession(env.OAUTH_KV, request);

  if (pathname === APP_PATH) {
    if (request.method !== "GET") return methodNotAllowed();

    return html(session ? renderAppPage(session.login) : renderSignInPage());
  }

  if (pathname === "/app/logout") {
    if (request.method !== "POST") return methodNotAllowed("POST");

    if (!sameOrigin(request, env))
      return jsonError(403, "Cross-origin request refused.");
    await deleteSession(env.OAUTH_KV, request);
    const response = redirect(APP_PATH, 303);
    appendSetCookie(response.headers, clearCookie(SESSION_COOKIE_NAME));

    return response;
  }

  const api =
    pathname === "/app/api/drift"
      ? "drift"
      : pathname === "/app/api/rules"
        ? "rules"
        : null;

  if (!api) return notFoundResponse();

  const allowed = api === "drift" ? ["POST"] : ["GET", "PUT"];

  if (!allowed.includes(request.method))
    return methodNotAllowed(allowed.join(", "));

  if (request.method !== "GET" && !sameOrigin(request, env))
    return jsonError(403, "Cross-origin request refused.");

  if (!session) return jsonError(401, "Sign in with GitHub to continue.");

  try {
    return api === "drift"
      ? await driftApi(request, session)
      : await rulesApi(request, env, session);
  } catch (error) {
    const { status, message } = errorMessage(error);

    return jsonError(status, message);
  }
}
