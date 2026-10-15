import { describe, expect, it, vi } from "vitest";

import { createSession, readSession } from "@/web/session";
import { memoryKv } from "@test/helpers/oauth-state";

describe("owner web sessions", () => {
  it("stores only the owner identity", async () => {
    const kv = memoryKv();
    const put = vi.spyOn(kv, "put");
    const secret = await createSession(kv, { login: "aranlucas", userId: 1001 });

    const request = new Request("https://shipshape.example/app", {
      headers: { Cookie: `__Host-shipshape-session=${secret}` },
    });

    expect(await readSession(kv, request)).toEqual({ login: "aranlucas", userId: 1001 });
    const value = put.mock.calls[0]?.[1] ?? "";
    expect(value).not.toContain("token");
    expect(value).not.toContain("iv");
  });
});
