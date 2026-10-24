import { stripControlCharacters } from "./control-characters";

const encoder = new TextEncoder();

const MAX_COOKIE_VALUE_LENGTH = 6_000;

export interface OAuthStateStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
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
  return encodeBase64Url(await crypto.subtle.digest("SHA-256", encoder.encode(browserToken)));
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");

  if (header === null) {
    return null;
  }

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");

    if (separator < 0) {
      continue;
    }

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

export function makeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const attributes = ["Path=/", "HttpOnly", "Secure", `SameSite=${options.sameSite ?? "Lax"}`];

  if (options.maxAge !== undefined) {
    attributes.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }

  return `${name}=${value}; ${attributes.join("; ")}`;
}

export function clearCookie(name: string): string {
  return makeCookie(name, "", { maxAge: 0 });
}

export function escapeHtml(value: string): string {
  return stripControlCharacters(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'";

export function securityHeaders(): Headers {
  const headers = new Headers();
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);

  return headers;
}

export function isSafeToken(value: string): boolean {
  return value.length >= 16 && value.length <= 512 && /^[A-Za-z0-9_-]+$/u.test(value);
}

function encodeBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";

  for (const byte of view) {
    binary += String.fromCodePoint(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);

  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;

  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }

  return difference === 0;
}

type CookieOptions = { maxAge?: number; sameSite?: "Strict" | "Lax" | "None" };
