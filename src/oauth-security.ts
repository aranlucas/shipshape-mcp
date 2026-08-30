import type {
  AuthRequest,
  ClientInfo,
} from "@cloudflare/workers-oauth-provider";

export const BROWSER_COOKIE_NAME = "__Host-shipshape-browser";
export const CSRF_COOKIE_NAME = "__Host-shipshape-csrf";
export const APPROVED_CLIENT_COOKIE_NAME = "__Host-shipshape-approved";

export const AUTHORIZATION_STATE_TTL_SECONDS = 10 * 60;
export const APPROVED_CLIENT_TTL_SECONDS = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();
const MAX_COOKIE_VALUE_LENGTH = 6_000;
const MAX_STATE_RECORD_LENGTH = 32_000;

export interface AuthorizationStateRecord {
  kind: "authorization";
  browserBinding: string;
  createdAt: number;
  oauthRequest: AuthRequest;
}

export interface GitHubStateRecord {
  kind: "github";
  browserBinding: string;
  createdAt: number;
  oauthRequest: AuthRequest;
}

export type OAuthStateRecord = AuthorizationStateRecord | GitHubStateRecord;

export interface ApprovedClientRecord {
  clientId: string;
  redirectUri: string;
  scope: string;
  expiresAt: number;
}

export interface SanitizedClientMetadata {
  clientName: string;
  clientUri?: string;
  logoUri?: string;
  policyUri?: string;
  tosUri?: string;
  contacts: string[];
  redirectUris: string[];
}

export function randomToken(byteLength = 32): string {
  if (!Number.isInteger(byteLength) || byteLength < 16 || byteLength > 128) {
    throw new Error("Invalid token length");
  }

  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

export async function browserBinding(browserToken: string): Promise<string> {
  return encodeBase64Url(
    await crypto.subtle.digest("SHA-256", encoder.encode(browserToken)),
  );
}

export async function putBrowserBoundState(
  kv: KVNamespace,
  state: string,
  record: OAuthStateRecord,
  browserToken: string,
  expirationTtl = AUTHORIZATION_STATE_TTL_SECONDS,
): Promise<void> {
  if (!isSafeToken(state)) throw new Error("Invalid OAuth state");
  const value: OAuthStateRecord = {
    ...record,
    browserBinding: await browserBinding(browserToken),
  };
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_STATE_RECORD_LENGTH) {
    throw new Error("OAuth state record is too large");
  }

  await kv.put(stateKey(state), serialized, { expirationTtl });
}

/**
 * Reads and immediately deletes a valid state record. KV does not expose a
 * compare-and-delete primitive, so the state is kept deliberately short lived
 * and is invalidated before any external operation begins.
 */
export async function consumeBrowserBoundState(
  kv: KVNamespace,
  state: string,
  browserToken: string,
): Promise<OAuthStateRecord | null> {
  if (!isSafeToken(state)) return null;

  const serialized = await kv.get(stateKey(state));
  if (serialized === null || serialized.length > MAX_STATE_RECORD_LENGTH)
    return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }

  if (!isOAuthStateRecord(parsed)) return null;
  if (parsed.createdAt + AUTHORIZATION_STATE_TTL_SECONDS * 1_000 < Date.now())
    return null;
  const expectedBinding = await browserBinding(browserToken);
  if (!(await constantTimeEqual(parsed.browserBinding, expectedBinding)))
    return null;

  await kv.delete(stateKey(state));
  return parsed;
}

export async function createSignedApprovalCookie(
  record: ApprovedClientRecord,
  secret: string,
): Promise<string> {
  validateApprovedClientRecord(record);
  const payload = encodeBase64Url(encoder.encode(JSON.stringify(record)));
  const signature = await sign(payload, secret);
  const cookieValue = `${payload}.${signature}`;
  if (cookieValue.length > MAX_COOKIE_VALUE_LENGTH) {
    throw new Error("Approved-client cookie is too large");
  }
  return cookieValue;
}

export async function parseSignedApprovalCookie(
  cookieValue: string | null,
  secret: string,
  now = Date.now(),
): Promise<ApprovedClientRecord | null> {
  if (
    cookieValue === null ||
    cookieValue.length === 0 ||
    cookieValue.length > MAX_COOKIE_VALUE_LENGTH
  ) {
    return null;
  }

  const separator = cookieValue.indexOf(".");
  if (separator <= 0 || separator !== cookieValue.lastIndexOf(".")) return null;
  const payload = cookieValue.slice(0, separator);
  const signature = cookieValue.slice(separator + 1);
  if (!isBase64Url(payload) || !isBase64Url(signature)) return null;
  if (!(await verify(payload, signature, secret))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
  } catch {
    return null;
  }

  if (!isApprovedClientRecord(parsed) || parsed.expiresAt <= now) return null;
  return parsed;
}

export function approvalMatches(
  record: ApprovedClientRecord | null,
  request: Pick<AuthRequest, "clientId" | "redirectUri" | "scope">,
  now = Date.now(),
): boolean {
  if (record === null || record.expiresAt <= now) return false;
  return (
    record.clientId === request.clientId &&
    record.redirectUri === request.redirectUri &&
    record.scope === canonicalScope(request.scope)
  );
}

export function canonicalScope(scope: readonly string[]): string {
  return [...new Set(scope)].sort().join(" ");
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (header === null) return null;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const cookieName = part.slice(0, separator).trim();
    if (cookieName === name) {
      const value = part.slice(separator + 1).trim();
      return value.length <= MAX_COOKIE_VALUE_LENGTH ? value : null;
    }
  }
  return null;
}

export function appendSetCookie(headers: Headers, cookie: string): void {
  headers.append("Set-Cookie", cookie);
}

export function makeCookie(
  name: string,
  value: string,
  options: { maxAge?: number; sameSite?: "Strict" | "Lax" | "None" } = {},
): string {
  const attributes = [
    "Path=/",
    "HttpOnly",
    "Secure",
    `SameSite=${options.sameSite ?? "Lax"}`,
  ];
  if (options.maxAge !== undefined)
    attributes.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  return `${name}=${value}; ${attributes.join("; ")}`;
}

export function clearCookie(name: string): string {
  return makeCookie(name, "", { maxAge: 0 });
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;")
    .replace(/[\u0000-\u001f\u007f]/g, "");
}

export function safeHttpUrl(
  value: unknown,
  maxLength = 2_048,
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  )
    return undefined;

  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password
    ) {
      return undefined;
    }
    return parsed.href;
  } catch {
    return undefined;
  }
}

export function sanitizeClientMetadata(
  client: ClientInfo | null,
): SanitizedClientMetadata {
  if (client === null) {
    return {
      clientName: "Unknown application",
      contacts: [],
      redirectUris: [],
    };
  }

  const clientName = sanitizeText(
    client.clientName,
    "Unknown application",
    256,
  );
  const contacts = Array.isArray(client.contacts)
    ? client.contacts
        .filter((contact): contact is string => typeof contact === "string")
        .map((contact) => sanitizeText(contact, "", 320))
        .filter((contact) => contact.length > 0)
        .slice(0, 10)
    : [];
  const redirectUris = Array.isArray(client.redirectUris)
    ? client.redirectUris
        .map((uri) => safeHttpUrl(uri))
        .filter((uri): uri is string => uri !== undefined)
        .slice(0, 10)
    : [];

  return {
    clientName,
    clientUri: safeHttpUrl(client.clientUri),
    logoUri: safeHttpUrl(client.logoUri),
    policyUri: safeHttpUrl(client.policyUri),
    tosUri: safeHttpUrl(client.tosUri),
    contacts,
    redirectUris,
  };
}

export function securityHeaders(): Headers {
  const headers = new Headers();
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; script-src 'none'; style-src 'self'; object-src 'none'; connect-src 'none'",
  );
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains",
  );
  return headers;
}

export function isSafeToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 16 &&
    value.length <= 512 &&
    isBase64Url(value)
  );
}

function stateKey(state: string): string {
  return `oauth:state:${state}`;
}

function sanitizeText(
  value: unknown,
  fallback: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const withoutControls = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return withoutControls.length > 0
    ? withoutControls.slice(0, maxLength)
    : fallback;
}

function validateApprovedClientRecord(record: ApprovedClientRecord): void {
  if (
    !isSafeClientString(record.clientId) ||
    !isSafeClientString(record.redirectUri) ||
    !isSafeScopeString(record.scope) ||
    !Number.isSafeInteger(record.expiresAt)
  ) {
    throw new Error("Invalid approved-client record");
  }
}

function isApprovedClientRecord(value: unknown): value is ApprovedClientRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.clientId === "string" &&
    isSafeClientString(record.clientId) &&
    typeof record.redirectUri === "string" &&
    isSafeClientString(record.redirectUri) &&
    typeof record.scope === "string" &&
    isSafeScopeString(record.scope) &&
    typeof record.expiresAt === "number" &&
    Number.isSafeInteger(record.expiresAt)
  );
}

function isOAuthStateRecord(value: unknown): value is OAuthStateRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.kind !== "authorization" && record.kind !== "github") return false;
  if (
    typeof record.browserBinding !== "string" ||
    !isBase64Url(record.browserBinding)
  )
    return false;
  if (
    typeof record.createdAt !== "number" ||
    !Number.isSafeInteger(record.createdAt)
  )
    return false;
  return isAuthRequest(record.oauthRequest);
}

function isAuthRequest(value: unknown): value is AuthRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.responseType === "string" &&
    typeof request.clientId === "string" &&
    isSafeClientString(request.clientId) &&
    typeof request.redirectUri === "string" &&
    isSafeClientString(request.redirectUri) &&
    Array.isArray(request.scope) &&
    request.scope.every(
      (scope): scope is string =>
        typeof scope === "string" && isSafeScope(scope),
    ) &&
    typeof request.state === "string" &&
    request.state.length <= 512
  );
}

function isSafeClientString(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 2_048 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isSafeScope(scope: string): boolean {
  return scope.length <= 256 && /^[A-Za-z0-9:._-]+$/.test(scope);
}

function isSafeScopeString(scope: string): boolean {
  return (
    scope.length <= 2_048 &&
    (scope === "" || scope.split(" ").every(isSafeScope))
  );
}

function isBase64Url(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value);
}

function encodeBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeBase64Url(value: string): ArrayBuffer {
  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await signingKey(secret, ["sign"]);
  return encodeBase64Url(
    await crypto.subtle.sign("HMAC", key, encoder.encode(payload)),
  );
}

async function verify(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  try {
    const key = await signingKey(secret, ["verify"]);
    return await crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64Url(signature),
      encoder.encode(payload),
    );
  } catch {
    return false;
  }
}

async function signingKey(
  secret: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  if (secret.length === 0 || secret.length > 4_096)
    throw new Error("Invalid cookie signing secret");
  const encoded = encoder.encode(secret);
  const raw = encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  );
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

async function constantTimeEqual(
  left: string,
  right: string,
): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1)
    difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}
