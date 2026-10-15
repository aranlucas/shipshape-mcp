import { isOwner } from "../auth/owner";
import { methodNotAllowed, notFoundResponse } from "../landing";
import { CALLBACK_PATH, callbackUrl, completeGitHubLogin, type OAuthEnv } from "../oauth";
import {
  appendSetCookie,
  clearCookie,
  escapeHtml,
  getCookie,
  makeCookie,
  securityHeaders,
} from "../oauth-security";
import { renderMissingBundlePage, renderSignInPage } from "./placeholder";
import { apiHandler } from "../api/routes";
import type { AppEnv } from "../env";
import {
  LOGIN_COOKIE_NAME,
  LOGIN_STATE_TTL_SECONDS,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  WEB_LOGIN_STATE_PREFIX,
  consumeLoginState,
  createLoginState,
  createSession,
  deleteSession,
  readSession,
} from "./session";

export const APP_PATH = "/app" as const;

export const WEB_CALLBACK_PATH = CALLBACK_PATH;

const LEGACY_WEB_CALLBACK_PATH = "/callback/web";

const APP_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const SHELL_PATH = "/app/index.html";

const LOGIN_META = /<meta name="shipshape-login" content="[^"]*"\s*\/?>/u;

/** Client-side routes rendered by the dashboard bundle (src/ui/router.ts). */
function isDashboardPage(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean).slice(1);

  return (
    parts.length === 0 ||
    (parts[0] === "repos" && parts.length === 3) ||
    (parts[0] === "practices" && parts.length <= 2)
  );
}

/** Serves the built shell with the signed-in login, or explains how to build it. */
async function dashboardShell(request: Request, env: OAuthEnv, login: string): Promise<Response> {
  const shell = env.ASSETS
    ? await env.ASSETS.fetch(new Request(new URL(SHELL_PATH, request.url)))
    : null;

  if (!shell?.ok) {
    return html(renderMissingBundlePage(login));
  }

  const page = await shell.text();

  return html(
    page.replace(LOGIN_META, `<meta name="shipshape-login" content="${escapeHtml(login)}">`),
  );
}

export function isWebPath(pathname: string, state: string | null = null): boolean {
  return (
    pathname === APP_PATH ||
    pathname.startsWith(`${APP_PATH}/`) ||
    pathname === LEGACY_WEB_CALLBACK_PATH ||
    (pathname === WEB_CALLBACK_PATH && state?.startsWith(WEB_LOGIN_STATE_PREFIX) === true)
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
  return new Response(body, { status, headers: appHeaders("text/html; charset=utf-8") });
}

function redirect(location: string, status: 302 | 303 = 302): Response {
  const headers = securityHeaders();
  headers.set("Location", location);
  headers.set("Cache-Control", "no-store");

  return new Response(null, { status, headers });
}

function isDashboardApiPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean).slice(2);

  return (
    (parts.length === 1 && (parts[0] === "overview" || parts[0] === "refresh")) ||
    (parts.length === 3 && parts[0] === "repos") ||
    (parts.length === 2 && parts[0] === "practices")
  );
}

function publicOrigin(request: Request, env: OAuthEnv): string {
  return callbackUrl(request, env, "/").origin;
}

function sameOrigin(request: Request, env: OAuthEnv): boolean {
  const site = request.headers.get("Sec-Fetch-Site");

  return (
    request.headers.get("Origin") === publicOrigin(request, env) &&
    (site === null || site === "same-origin")
  );
}

async function startLogin(request: Request, env: OAuthEnv): Promise<Response> {
  const { state, browser } = await createLoginState(env.OAUTH_KV);
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.GITHUB_APP_CLIENT_ID);
  authorize.searchParams.set(
    "redirect_uri",
    callbackUrl(request, env, WEB_CALLBACK_PATH).toString(),
  );
  authorize.searchParams.set("state", state);
  const response = redirect(authorize.toString());
  appendSetCookie(
    response.headers,
    makeCookie(LOGIN_COOKIE_NAME, browser, { maxAge: LOGIN_STATE_TTL_SECONDS }),
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

  const identity = valid ? await completeGitHubLogin(request, env, url.pathname) : null;

  if (identity === null) {
    const response = html(
      renderSignInPage("GitHub sign-in could not be completed. Please try again."),
      400,
    );

    appendSetCookie(response.headers, clearCookie(LOGIN_COOKIE_NAME));

    return response;
  }

  if (!isOwner(env, identity)) {
    const response = html(
      renderSignInPage("This Shipshape instance belongs to another GitHub account."),
      403,
    );

    appendSetCookie(response.headers, clearCookie(LOGIN_COOKIE_NAME));

    return response;
  }

  const secret = await createSession(env.OAUTH_KV, identity);
  const response = redirect(APP_PATH);
  appendSetCookie(response.headers, clearCookie(LOGIN_COOKIE_NAME));
  appendSetCookie(
    response.headers,
    makeCookie(SESSION_COOKIE_NAME, secret, { maxAge: SESSION_TTL_SECONDS }),
  );

  return response;
}

export async function webHandler(
  request: Request,
  env: OAuthEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/app/login") {
    return request.method === "GET" ? startLogin(request, env) : methodNotAllowed();
  }

  if (pathname === WEB_CALLBACK_PATH || pathname === LEGACY_WEB_CALLBACK_PATH) {
    return request.method === "GET" ? finishLogin(request, env) : methodNotAllowed();
  }

  const storedSession = await readSession(env.OAUTH_KV, request);
  const session = storedSession !== null && isOwner(env, storedSession) ? storedSession : null;

  if (pathname.startsWith(`${APP_PATH}/api/`)) {
    if (!isDashboardApiPath(pathname)) {
      return notFoundResponse();
    }

    if (session === null) {
      return new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    // SAFETY: this fallback implements the sole ExecutionContext method used by the API handler.
    const executionContext =
      ctx ??
      ({
        waitUntil(promise: Promise<unknown>) {
          void promise.catch(() => null);
        },
      } as ExecutionContext);

    // SAFETY: OAuthEnv is the AppEnv subset carried by web requests; API handlers only use these bindings.
    return apiHandler(request, env as AppEnv, session, executionContext);
  }

  if ((pathname === APP_PATH || pathname.startsWith(`${APP_PATH}/`)) && isDashboardPage(pathname)) {
    if (request.method !== "GET") {
      return methodNotAllowed();
    }

    return session ? dashboardShell(request, env, session.login) : html(renderSignInPage());
  }

  if (pathname === "/app/logout") {
    if (request.method !== "POST") {
      return methodNotAllowed("POST");
    }

    if (!sameOrigin(request, env)) {
      return new Response(JSON.stringify({ error: "Cross-origin request refused." }), {
        status: 403,
        headers: appHeaders("application/json; charset=utf-8"),
      });
    }

    await deleteSession(env.OAUTH_KV, request);
    const response = redirect(APP_PATH, 303);
    appendSetCookie(response.headers, clearCookie(SESSION_COOKIE_NAME));

    return response;
  }

  return notFoundResponse();
}
