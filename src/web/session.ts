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

const encoder = new TextEncoder();

const SessionRecordSchema = z
  .object({
    login: GitHubOwnerInputSchema,
    iv: z.string().max(64),
    token: z.string().max(12_000),
    createdAt: z.number().int().safe(),
  })
  .strict();

const LoginStateSchema = z
  .object({ binding: z.string().max(64), createdAt: z.number().int().safe() })
  .strict();

export interface WebSession {
  readonly login: string;
  readonly accessToken: string;
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  return btoa(String.fromCharCode(...view))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));

  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function digest(label: string, secret: string) {
  return crypto.subtle.digest("SHA-256", encoder.encode(`${label}:${secret}`));
}

/** KV keys hold a hash of the cookie secret, never the secret itself. */
async function sessionKey(secret: string) {
  return `web:session:${base64Url(await digest("session", secret))}`;
}

/** The token key derives from the cookie secret, so KV alone cannot decrypt. */
async function tokenKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    await digest("token", secret),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

export async function createSession(
  kv: OAuthStateStore,
  session: WebSession,
): Promise<string> {
  const secret = randomToken(32);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const token = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await tokenKey(secret),
    encoder.encode(session.accessToken),
  );

  await kv.put(
    await sessionKey(secret),
    JSON.stringify({
      login: session.login,
      iv: base64Url(iv),
      token: base64Url(token),
      createdAt: Date.now(),
    }),
    { expirationTtl: SESSION_TTL_SECONDS },
  );

  return secret;
}

export async function readSession(
  kv: OAuthStateStore,
  request: Request,
): Promise<WebSession | null> {
  const secret = getCookie(request, SESSION_COOKIE_NAME);

  if (secret === null || !isSafeToken(secret)) return null;

  const serialized = await kv.get(await sessionKey(secret));

  if (serialized === null || serialized.length > 16_000) return null;

  let record: z.infer<typeof SessionRecordSchema>;

  try {
    record = SessionRecordSchema.parse(JSON.parse(serialized));
  } catch {
    return null;
  }

  if (record.createdAt + SESSION_TTL_SECONDS * 1_000 < Date.now()) return null;

  try {
    const token = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(record.iv) },
      await tokenKey(secret),
      fromBase64Url(record.token),
    );

    return {
      login: record.login,
      accessToken: new TextDecoder().decode(token),
    };
  } catch {
    return null;
  }
}

export async function deleteSession(
  kv: OAuthStateStore,
  request: Request,
): Promise<void> {
  const secret = getCookie(request, SESSION_COOKIE_NAME);

  if (secret !== null && isSafeToken(secret))
    await kv.delete(await sessionKey(secret));
}

/** One-time login state, bound to a browser cookie to stop login CSRF. */
export async function createLoginState(
  kv: OAuthStateStore,
): Promise<{ state: string; browser: string }> {
  const state = randomToken(32);
  const browser = randomToken(32);

  await kv.put(
    `web:state:${state}`,
    JSON.stringify({
      binding: await browserBinding(browser),
      createdAt: Date.now(),
    }),
    { expirationTtl: LOGIN_STATE_TTL_SECONDS },
  );

  return { state, browser };
}

export async function consumeLoginState(
  kv: OAuthStateStore,
  state: string | null,
  browser: string | null,
): Promise<boolean> {
  if (
    state === null ||
    browser === null ||
    !isSafeToken(state) ||
    !isSafeToken(browser)
  )
    return false;

  const key = `web:state:${state}`;
  const serialized = await kv.get(key);

  if (serialized === null || serialized.length > 1_000) return false;

  await kv.delete(key);

  const parsed = LoginStateSchema.safeParse(
    (() => {
      try {
        return JSON.parse(serialized);
      } catch {
        return null;
      }
    })(),
  );

  if (
    !parsed.success ||
    parsed.data.createdAt + LOGIN_STATE_TTL_SECONDS * 1_000 < Date.now()
  )
    return false;

  return constantTimeEqual(parsed.data.binding, await browserBinding(browser));
}
