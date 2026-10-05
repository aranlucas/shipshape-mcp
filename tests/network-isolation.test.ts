import { fetch as transportFetch } from "undici";
import { describe, expect, it } from "vitest";

describe("offline test guard", () => {
  it("blocks unexpected global fetches", async () => {
    await expect(fetch("https://unexpected.invalid/")).rejects.toThrow(
      "Unexpected outbound request",
    );
  });
  it("also blocks direct Undici requests and harness redirect destinations", async () => {
    await expect(
      transportFetch("https://unexpected.invalid/"),
    ).rejects.toMatchObject({
      cause: { code: "UND_MOCK_ERR_MOCK_NOT_MATCHED" },
    });
  });
});
