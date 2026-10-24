import { z } from "zod";
import { GitHubOwnerInputSchema } from "../github/schemas";
import {
  constantTimeEqual,
  browserBinding,
  getCookie,
  isSafeToken,
  randomToken,
  type OAuthStateStore,
} from "../oauth-security";

export const SESSION_COOKIE_NAME = "__Host-shipshape-session";

export const LOGIN_COOKIE_NAME = "__Host-shipshape-web-login";

export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export const LOGIN_STATE_TTL_SECONDS = 10 * 60;

export const WEB_LOGIN_STATE_PREFIX = "web_";

const encoder = new TextEncoder();

const SessionRecordSchema = z
  .object({
    login: GitHubOwnerInputSchema,
    userId: z.number().int().positive(),
    createdAt: z.number().int().safe(),
    expiresAt: z.number().int().positive().safe(),
  })
  .strict();

const LoginStateSchema = z
  .object({
    binding: z.string().max(64),
    createdAt: z.number().int().safe(),
    codeVerifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/u),
    clientId: z.string().min(1).max(2048),
    redirectUri: z.url(),
  })
  .strict();

export type LoginStateData = Pick<
  z.infer<typeof LoginStateSchema>,
  "codeVerifier" | "clientId" | "redirectUri"
>;

export interface WebSession {
  readonly login: string;
  readonly userId: number;
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  return btoa(String.fromCodePoint(...view))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function digest(label: string, secret: string) {
  return crypto.subtle.digest("SHA-256", encoder.encode(`${label}:${secret}`));
}

/** KV keys hold a hash of the cookie secret, never the secret itself. */
async function sessionKey(secret: string) {
  return `web:session:${base64Url(await digest("session", secret))}`;
}

export async function createSession(
  kv: OAuthStateStore,
  session: WebSession,
  expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
): Promise<string> {
  const secret = randomToken(32);
  const expiration = Math.min(expiresAt, Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS);

  await kv.put(
    await sessionKey(secret),
    JSON.stringify({
      login: session.login,
      userId: session.userId,
      createdAt: Date.now(),
      expiresAt: expiration,
    }),
    { expirationTtl: Math.max(60, expiration - Math.floor(Date.now() / 1000)) },
  );

  return secret;
}

export async function readSession(
  kv: OAuthStateStore,
  request: Request,
): Promise<WebSession | null> {
  const secret = getCookie(request, SESSION_COOKIE_NAME);

  if (secret === null || !isSafeToken(secret)) {
    return null;
  }

  const serialized = await kv.get(await sessionKey(secret));

  if (serialized === null || serialized.length > 16_000) {
    return null;
  }

  let record: z.infer<typeof SessionRecordSchema>;

  try {
    record = SessionRecordSchema.parse(JSON.parse(serialized));
  } catch {
    return null;
  }

  if (
    record.createdAt + SESSION_TTL_SECONDS * 1_000 <= Date.now() ||
    record.expiresAt * 1_000 <= Date.now()
  ) {
    return null;
  }

  return { login: record.login, userId: record.userId };
}

export async function deleteSession(kv: OAuthStateStore, request: Request): Promise<void> {
  const secret = getCookie(request, SESSION_COOKIE_NAME);

  if (secret !== null && isSafeToken(secret)) {
    await kv.delete(await sessionKey(secret));
  }
}

/** One-time login state, bound to a browser cookie to stop login CSRF. */
export async function createLoginState(
  kv: OAuthStateStore,
  login: LoginStateData,
): Promise<LoginState> {
  const state = WEB_LOGIN_STATE_PREFIX + randomToken(32);
  const browser = randomToken(32);

  await kv.put(
    `web:state:${state}`,
    JSON.stringify({
      binding: await browserBinding(browser),
      createdAt: Date.now(),
      ...login,
    }),
    { expirationTtl: LOGIN_STATE_TTL_SECONDS },
  );

  return { state, browser };
}

export async function consumeLoginState(
  kv: OAuthStateStore,
  state: string | null,
  browser: string | null,
): Promise<LoginStateData | null> {
  if (state === null || browser === null || !isSafeToken(state) || !isSafeToken(browser)) {
    return null;
  }

  const key = `web:state:${state}`;
  const serialized = await kv.get(key);

  if (serialized === null || serialized.length > 8_000) {
    return null;
  }

  await kv.delete(key);

  const parsed = LoginStateSchema.safeParse(
    (() => {
      try {
        const value: unknown = JSON.parse(serialized);

        return value;
      } catch {
        return null;
      }
    })(),
  );

  if (!parsed.success || parsed.data.createdAt + LOGIN_STATE_TTL_SECONDS * 1_000 < Date.now()) {
    return null;
  }

  if (!(await constantTimeEqual(parsed.data.binding, await browserBinding(browser)))) {
    return null;
  }

  const { codeVerifier, clientId, redirectUri } = parsed.data;

  return { codeVerifier, clientId, redirectUri };
}

type LoginState = { state: string; browser: string };
