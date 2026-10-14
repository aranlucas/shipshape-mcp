import { expect, test } from "vitest";
import { escapeHtml } from "@/oauth-security";
import { memoryKv } from "@test/helpers/oauth-state";

test("resolves source and test-helper aliases", async () => {
  const store = memoryKv();
  const value = escapeHtml("<alias>");

  await store.put("alias", value);

  expect(await store.get("alias")).toBe("&lt;alias&gt;");
});
