import {
  AuthorizationError,
  type AuthRequest,
  type ClientInfo,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import * as oauth from "oauth4webapi";
import { z } from "zod";

import { GITHUB_SCOPE, MCP_SCOPE } from "./config";
import { landingHandler, methodNotAllowed, notFoundResponse } from "./landing";
import {
  APPROVED_CLIENT_COOKIE_NAME,
  APPROVED_CLIENT_TTL_SECONDS,
  BROWSER_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  type ApprovedClientRecord,
  type GitHubStateRecord,
  type OAuthStateRecord,
  appendSetCookie,
  approvalMatches,
  canonicalScope,
  clearCookie,
  consumeBrowserBoundState,
  createSignedApprovalCookie,
  escapeHtml,
  getCookie,
  isSafeToken,
  makeCookie,
  parseSignedApprovalCookie,
  putBrowserBoundState,
  randomToken,
  sanitizeClientMetadata,
  securityHeaders,
} from "./oauth-security";
import { STYLES_PATH } from "./styles";

export { GITHUB_SCOPE } from "./config";
export const AUTHORIZE_PATH = "/authorize" as const;
export const CALLBACK_PATH = "/callback" as const;

const GENERIC_AUTHORIZATION_ERROR =
  "The authorization request could not be completed.";
const GENERIC_UPSTREAM_ERROR =
  "GitHub authorization is temporarily unavailable.";
const MAX_UPSTREAM_BODY_LENGTH = 32_000;
const MAX_OAUTH_VALUE_LENGTH = 4_096;
const UPSTREAM_TIMEOUT_MS = 8_000;

const GITHUB_AUTHORIZATION_SERVER: oauth.AuthorizationServer = {
  issuer: "https://github.com/login/oauth",
  authorization_endpoint: "https://github.com/login/oauth/authorize",
  token_endpoint: "https://github.com/login/oauth/access_token",
};
const GITHUB_CLIENT_USER_ENDPOINT = new URL("https://api.github.com/user");
const GitHubUserSchema = z.object({ login: z.string() });

export interface OAuthEnv {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY?: string;
  GITHUB_API_VERSION?: string;
  PUBLIC_ORIGIN?: string;
}

export const defaultHandler: ExportedHandler<OAuthEnv> = {
  async fetch(request, env) {
    try {
      return await handleDefaultRequest(request, env);
    } catch {
      const response = genericErrorResponse(500);
      if (
        request.method === "POST" &&
        new URL(request.url).pathname === AUTHORIZE_PATH
      ) {
        appendSetCookie(response.headers, clearCookie(CSRF_COOKIE_NAME));
      }
      return response;
    }
  },
};

export const oauthHandler = defaultHandler;

export default defaultHandler;

export async function handleDefaultRequest(
  request: Request,
  env: OAuthEnv,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;

  if (pathname === AUTHORIZE_PATH) return handleAuthorize(request, env);
  if (pathname === CALLBACK_PATH) return handleCallback(request, env);
  if (
    pathname === "/" ||
    pathname === "/health" ||
    pathname === "/privacy" ||
    pathname === STYLES_PATH
  ) {
    return landingHandler(request);
  }
  return notFoundResponse();
}

async function handleAuthorize(
  request: Request,
  env: OAuthEnv,
): Promise<Response> {
  if (request.method === "GET") return handleAuthorizeGet(request, env);
  if (request.method === "POST") return handleAuthorizePost(request, env);
  return methodNotAllowed();
}

async function handleAuthorizeGet(
  request: Request,
  env: OAuthEnv,
): Promise<Response> {
  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    return authorizationParseError(error);
  }

  let client: ClientInfo | null;
  try {
    client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  } catch {
    return genericErrorResponse(500);
  }
  if (client === null) return genericErrorResponse(400);

  let browserToken = getCookie(request, BROWSER_COOKIE_NAME);
  const cookies: string[] = [];
  if (browserToken === null || !isSafeToken(browserToken)) {
    browserToken = randomToken();
    cookies.push(makeCookie(BROWSER_COOKIE_NAME, browserToken));
  }

  const approved = await parseSignedApprovalCookie(
    getCookie(request, APPROVED_CLIENT_COOKIE_NAME),
    env.COOKIE_ENCRYPTION_KEY ?? "",
  );
  if (approvalMatches(approved, oauthRequest)) {
    return beginGitHubAuthorization(
      request,
      env,
      oauthRequest,
      browserToken,
      cookies,
    );
  }

  const state = randomToken();
  const csrfToken = randomToken();
  const stateRecord: OAuthStateRecord = {
    kind: "authorization",
    browserBinding: "",
    createdAt: Date.now(),
    oauthRequest,
  };
  await putBrowserBoundState(env.OAUTH_KV, state, stateRecord, browserToken);

  const headers = securityHeaders();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  appendSetCookie(headers, makeCookie(CSRF_COOKIE_NAME, csrfToken));
  for (const cookie of cookies) appendSetCookie(headers, cookie);
  return new Response(
    renderConsentDialog(client, oauthRequest, state, csrfToken),
    {
      status: 200,
      headers,
    },
  );
}

async function handleAuthorizePost(
  request: Request,
  env: OAuthEnv,
): Promise<Response> {
  const clearCsrf = clearCookie(CSRF_COOKIE_NAME);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return withCookies(genericErrorResponse(400), [clearCsrf]);
  }

  const state = formValue(form, "state");
  const submittedCsrf = formValue(form, "csrf");
  const decision = formValue(form, "decision");
  const csrfCookie = getCookie(request, CSRF_COOKIE_NAME);
  if (
    state === null ||
    submittedCsrf === null ||
    decision === null ||
    csrfCookie === null ||
    !(await secureEqual(submittedCsrf, csrfCookie))
  ) {
    return withCookies(genericErrorResponse(400), [clearCsrf]);
  }

  const browserToken = getCookie(request, BROWSER_COOKIE_NAME);
  if (browserToken === null || !isSafeToken(browserToken)) {
    return withCookies(genericErrorResponse(400), [clearCsrf]);
  }

  const stateRecord = await consumeBrowserBoundState(
    env.OAUTH_KV,
    state,
    browserToken,
  );
  if (stateRecord === null || stateRecord.kind !== "authorization") {
    return withCookies(genericErrorResponse(400), [clearCsrf]);
  }

  if (decision !== "approve") {
    return withCookies(
      oauthErrorRedirect(stateRecord.oauthRequest, "access_denied"),
      [clearCsrf],
    );
  }

  return withCookies(
    await beginGitHubAuthorization(
      request,
      env,
      stateRecord.oauthRequest,
      browserToken,
    ),
    [clearCsrf],
  );
}

async function beginGitHubAuthorization(
  request: Request,
  env: OAuthEnv,
  oauthRequest: AuthRequest,
  browserToken: string,
  cookies: string[] = [],
): Promise<Response> {
  const state = randomToken();
  const stateRecord: GitHubStateRecord = {
    kind: "github",
    browserBinding: "",
    createdAt: Date.now(),
    oauthRequest,
  };
  await putBrowserBoundState(env.OAUTH_KV, state, stateRecord, browserToken);

  const callback = callbackUrl(request, env);
  const githubUrl = new URL("https://github.com/login/oauth/authorize");
  githubUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  githubUrl.searchParams.set("redirect_uri", callback.toString());
  githubUrl.searchParams.set("scope", GITHUB_SCOPE);
  githubUrl.searchParams.set("state", state);

  const response = redirectResponse(githubUrl.toString());
  for (const cookie of cookies) appendSetCookie(response.headers, cookie);
  return response;
}

async function handleCallback(
  request: Request,
  env: OAuthEnv,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();

  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const browserToken = getCookie(request, BROWSER_COOKIE_NAME);
  if (
    state === null ||
    !isSafeToken(state) ||
    browserToken === null ||
    !isSafeToken(browserToken)
  ) {
    return genericErrorResponse(400);
  }

  const stateRecord = await consumeBrowserBoundState(
    env.OAUTH_KV,
    state,
    browserToken,
  );
  if (stateRecord === null || stateRecord.kind !== "github") {
    return genericErrorResponse(400);
  }

  if (url.searchParams.has("error")) {
    return oauthErrorRedirect(stateRecord.oauthRequest, "access_denied");
  }

  const code = url.searchParams.get("code");
  if (code === null || !isSafeUpstreamValue(code)) {
    return oauthErrorRedirect(stateRecord.oauthRequest, "server_error");
  }

  let callbackParameters: URLSearchParams;
  try {
    callbackParameters = oauth.validateAuthResponse(
      GITHUB_AUTHORIZATION_SERVER,
      { client_id: env.GITHUB_CLIENT_ID },
      url.searchParams,
      oauth.skipStateCheck,
    );
  } catch {
    reportOAuthFailure("github_authorization_response");
    return oauthErrorRedirect(stateRecord.oauthRequest, "server_error");
  }

  const accessToken = await exchangeGitHubCode(
    callbackParameters,
    request,
    env,
  );
  if (accessToken === null) {
    return oauthErrorRedirect(stateRecord.oauthRequest, "server_error");
  }

  const login = await fetchAndValidateGitHubUser(accessToken, env);
  if (login === null) {
    reportOAuthFailure("github_user_validation");
    return oauthErrorRedirect(stateRecord.oauthRequest, "server_error");
  }

  let client: ClientInfo | null;
  try {
    client = await env.OAUTH_PROVIDER.lookupClient(
      stateRecord.oauthRequest.clientId,
    );
  } catch {
    reportOAuthFailure("client_lookup");
    return oauthErrorRedirect(stateRecord.oauthRequest, "server_error");
  }
  if (client === null) {
    reportOAuthFailure("client_missing");
    return oauthErrorRedirect(stateRecord.oauthRequest, "unauthorized_client");
  }

  let redirectTo: string;
  try {
    const completed = await env.OAUTH_PROVIDER.completeAuthorization({
      request: stateRecord.oauthRequest,
      userId: `github-${login.toLowerCase()}`,
      metadata: { clientName: sanitizeClientMetadata(client).clientName },
      scope: stateRecord.oauthRequest.scope.filter(
        (scope) => scope === MCP_SCOPE,
      ),
      props: { accessToken, login },
    });
    redirectTo = completed.redirectTo;
  } catch {
    reportOAuthFailure("provider_authorization");
    return oauthErrorRedirect(stateRecord.oauthRequest, "server_error");
  }

  const response = redirectResponse(redirectTo);
  appendSetCookie(response.headers, clearCookie(CSRF_COOKIE_NAME));
  const approvalCookie = await makeApprovalCookie(
    stateRecord.oauthRequest,
    env,
  );
  if (approvalCookie !== null)
    appendSetCookie(response.headers, approvalCookie);
  return response;
}

export function renderConsentDialog(
  client: ClientInfo | null,
  oauthRequest: AuthRequest,
  state: string,
  csrfToken: string,
): string {
  const metadata = sanitizeClientMetadata(client);
  const scopes = oauthRequest.scope.length
    ? oauthRequest.scope
        .map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`)
        .join("")
    : "<li>No additional MCP scopes requested</li>";
  const clientUri = metadata.clientUri
    ? `<p>Website: <a href="${escapeHtml(metadata.clientUri)}" rel="noreferrer">${escapeHtml(metadata.clientUri)}</a></p>`
    : "";
  const policy = metadata.policyUri
    ? `<a href="${escapeHtml(metadata.policyUri)}" rel="noreferrer">Privacy policy</a>`
    : "";
  const terms = metadata.tosUri
    ? `<a href="${escapeHtml(metadata.tosUri)}" rel="noreferrer">Terms</a>`
    : "";
  const legalLinks = [policy, terms]
    .filter((link) => link.length > 0)
    .join(" · ");
  const contacts = metadata.contacts.length
    ? `<p>Contact: ${metadata.contacts.map((contact) => escapeHtml(contact)).join(", ")}</p>`
    : "";
  const redirects = metadata.redirectUris.length
    ? `<details><summary>Registered redirect URI</summary><ul>${metadata.redirectUris
        .map((uri) => `<li><code>${escapeHtml(uri)}</code></li>`)
        .join("")}</ul></details>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="${STYLES_PATH}">
    <title>Authorize ${escapeHtml(metadata.clientName)}</title>
  </head>
  <body>
    <main class="consent-shell">
      <section class="consent-card">
      <div class="brand-row"><a class="wordmark" href="/">Shipshape <span>/ MCP</span></a><span class="eyebrow">Read only</span></div>
      <h1>Authorize ${escapeHtml(metadata.clientName)}</h1>
      ${clientUri}
      <p>This application is requesting read-only access through Shipshape MCP.</p>
      <h2>Requested MCP scopes</h2>
      <ul class="scope-list">${scopes}</ul>
      <p class="permission-note">GitHub permission: <code>${GITHUB_SCOPE}</code>. Shipshape will inspect public repositories only.</p>
      ${redirects}
      ${contacts}
      ${legalLinks ? `<p class="legal-links">${legalLinks}</p>` : ""}
      <form method="post" action="${AUTHORIZE_PATH}">
        <input type="hidden" name="state" value="${escapeHtml(state)}">
        <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
        <div class="button-row">
          <button class="button-primary" type="submit" name="decision" value="approve">Continue with GitHub</button>
          <button class="button-secondary" type="submit" name="decision" value="deny">Cancel</button>
        </div>
      </form>
      </section>
    </main>
  </body>
</html>`;
}

async function exchangeGitHubCode(
  callbackParameters: URLSearchParams,
  request: Request,
  env: OAuthEnv,
): Promise<string | null> {
  const callback = callbackUrl(request, env);
  try {
    const client: oauth.Client = { client_id: env.GITHUB_CLIENT_ID };
    const response = await oauth.authorizationCodeGrantRequest(
      GITHUB_AUTHORIZATION_SERVER,
      client,
      oauth.ClientSecretPost(env.GITHUB_CLIENT_SECRET),
      callbackParameters,
      callback.toString(),
      oauth.nopkce,
      { [oauth.customFetch]: boundedOAuthFetch },
    );
    const payload = await oauth.processAuthorizationCodeResponse(
      GITHUB_AUTHORIZATION_SERVER,
      client,
      response,
    );
    return isSafeUpstreamValue(payload.access_token)
      ? payload.access_token
      : null;
  } catch {
    reportOAuthFailure("github_token_exchange");
    return null;
  }
}

async function fetchAndValidateGitHubUser(
  accessToken: string,
  env: OAuthEnv,
): Promise<string | null> {
  let response: Response;
  try {
    response = await oauth.protectedResourceRequest(
      accessToken,
      "GET",
      GITHUB_CLIENT_USER_ENDPOINT,
      new Headers({
        Accept: "application/vnd.github+json",
        "User-Agent": "shipshape-mcp",
        "X-GitHub-Api-Version": env.GITHUB_API_VERSION ?? "2026-03-10",
      }),
      undefined,
      { [oauth.customFetch]: boundedOAuthFetch },
    );
  } catch {
    reportOAuthFailure("github_user_validation");
    return null;
  }

  const contentType = response.headers.get("Content-Type");
  if (
    !response.ok ||
    (contentType !== null &&
      !contentType.toLowerCase().includes("application/json"))
  ) {
    return null;
  }
  const payload = await readJson(response);
  const user = GitHubUserSchema.safeParse(payload);
  return user.success && isGitHubLogin(user.data.login)
    ? user.data.login
    : null;
}

async function boundedOAuthFetch(
  input: string,
  options: oauth.CustomFetchOptions<string, oauth.ProtectedResourceRequestBody>,
): Promise<Response> {
  const body =
    options.body instanceof Uint8Array
      ? new Uint8Array(options.body)
      : options.body;
  const response = await fetchWithTimeout(input, {
    method: options.method,
    headers: options.headers,
    body,
    signal: options.signal,
  });
  if (await responseBodyExceedsLimit(response)) {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  return response;
}

async function responseBodyExceedsLimit(response: Response): Promise<boolean> {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_UPSTREAM_BODY_LENGTH
  ) {
    await response.body?.cancel();
    return true;
  }
  if (response.body === null) return false;

  try {
    const reader = response.clone().body?.getReader();
    if (reader === undefined) return false;
    let bytesRead = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) return false;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_UPSTREAM_BODY_LENGTH) {
        await reader.cancel();
        await response.body.cancel();
        return true;
      }
    }
  } catch {
    await response.body?.cancel();
    return true;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const declaredLength = Number(response.headers.get("Content-Length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_UPSTREAM_BODY_LENGTH
    ) {
      await response.body?.cancel();
      return null;
    }
    if (response.body === null) return null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytesRead = 0;
    let body = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_UPSTREAM_BODY_LENGTH) {
        await reader.cancel();
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    if (body.length === 0) return null;
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function callbackUrl(request: Request, env: OAuthEnv): URL {
  const requestOrigin = new URL(request.url).origin;
  const configuredOrigin = env.PUBLIC_ORIGIN?.trim() || requestOrigin;
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
  return new URL(CALLBACK_PATH, origin);
}

function reportOAuthFailure(stage: string): void {
  console.warn("OAuth callback could not be completed", { stage });
}

async function makeApprovalCookie(
  request: AuthRequest,
  env: OAuthEnv,
): Promise<string | null> {
  if (
    env.COOKIE_ENCRYPTION_KEY === undefined ||
    env.COOKIE_ENCRYPTION_KEY.length === 0
  )
    return null;
  const record: ApprovedClientRecord = {
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    scope: canonicalScope(request.scope),
    expiresAt: Date.now() + APPROVED_CLIENT_TTL_SECONDS * 1_000,
  };
  try {
    const value = await createSignedApprovalCookie(
      record,
      env.COOKIE_ENCRYPTION_KEY,
    );
    return makeCookie(APPROVED_CLIENT_COOKIE_NAME, value, {
      maxAge: APPROVED_CLIENT_TTL_SECONDS,
    });
  } catch {
    return null;
  }
}

function authorizationParseError(error: unknown): Response {
  if (!(error instanceof AuthorizationError)) return genericErrorResponse(500);
  if (error.redirectUri === undefined) return genericErrorResponse(400);

  try {
    const redirect = new URL(error.redirectUri);
    redirect.searchParams.set("error", error.code);
    redirect.searchParams.set("error_description", GENERIC_AUTHORIZATION_ERROR);
    if (error.state !== undefined)
      redirect.searchParams.set("state", error.state);
    if (error.issuer !== undefined)
      redirect.searchParams.set("iss", error.issuer);
    return redirectResponse(redirect.toString());
  } catch {
    return genericErrorResponse(400);
  }
}

function oauthErrorRedirect(
  request: AuthRequest,
  error: "access_denied" | "server_error" | "unauthorized_client",
): Response {
  try {
    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set("error", error);
    redirect.searchParams.set(
      "error_description",
      error === "access_denied"
        ? "Authorization was cancelled."
        : GENERIC_UPSTREAM_ERROR,
    );
    if (request.state !== "") redirect.searchParams.set("state", request.state);
    if (request.issuer !== undefined)
      redirect.searchParams.set("iss", request.issuer);
    return redirectResponse(redirect.toString());
  } catch {
    return genericErrorResponse(400);
  }
}

function genericErrorResponse(status: 400 | 405 | 500): Response {
  const headers = securityHeaders();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  const title =
    status >= 500 ? "Service unavailable" : "Request could not be completed";
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><p>${GENERIC_AUTHORIZATION_ERROR}</p></main></body></html>`,
    { status, headers },
  );
}

function redirectResponse(location: string): Response {
  const headers = securityHeaders();
  headers.set("Location", location);
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers });
}

function withCookies(response: Response, cookies: string[]): Response {
  for (const cookie of cookies) appendSetCookie(response.headers, cookie);
  return response;
}

function formValue(form: FormData, key: string): string | null {
  const value = form.get(key);
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_OAUTH_VALUE_LENGTH
  )
    return null;
  return value;
}

function isSafeUpstreamValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_OAUTH_VALUE_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isGitHubLogin(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 39 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value)
  );
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1)
    difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}
