import { constantTimeEqual } from "../oauth-security";

export async function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string | null,
): Promise<boolean> {
  if (!header?.startsWith("sha256=")) {
    return false;
  }

  const expected = header.slice(7);

  if (!/^[0-9a-f]{64}$/iu.test(expected)) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );

  const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");

  return constantTimeEqual(actual, expected.toLowerCase());
}
