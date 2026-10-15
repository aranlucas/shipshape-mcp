import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "@/github/webhook";

describe("verifyWebhookSignature", () => {
  it("accepts valid sha256 signatures and rejects malformed ones", async () => {
    const body = "hello";

    const bytes = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const sig = Buffer.from(
      await crypto.subtle.sign("HMAC", bytes, new TextEncoder().encode(body)),
    ).toString("hex");

    await expect(verifyWebhookSignature("secret", body, `sha256=${sig}`)).resolves.toBe(true);
    await expect(verifyWebhookSignature("wrong", body, `sha256=${sig}`)).resolves.toBe(false);
    await expect(verifyWebhookSignature("secret", body, null)).resolves.toBe(false);
    await expect(verifyWebhookSignature("secret", body, `sha1=${sig}`)).resolves.toBe(false);
    await expect(verifyWebhookSignature("secret", body, "sha256=00")).resolves.toBe(false);
  });
});
