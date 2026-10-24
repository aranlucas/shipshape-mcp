import { afterEach, describe, expect, it, vi } from "vitest";

import {
  consumeLoginState,
  createLoginState,
  createSession,
  deleteSession,
  LOGIN_STATE_TTL_SECONDS,
  readSession,
  SESSION_TTL_SECONDS,
} from "@/web/session";
import { memoryKv } from "@test/helpers/oauth-state";

const identity = { login: "aranlucas", userId: 1001 };

const login = {
  codeVerifier: "synthetic-pkce-verifier-with-at-least-forty-three-characters",
  clientId: "dashboard-public-client",
  redirectUri: "https://shipshape.example/callback/web",
};

function sessionRequest(secret: string) {
  return new Request("https://shipshape.example/app", {
    headers: { Cookie: `__Host-shipshape-session=${secret}` },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("owner web sessions", () => {
  it("stores only owner identity and expiry under a hash of the session cookie", async () => {
    const kv = memoryKv();
    const put = vi.spyOn(kv, "put");
    const expiresAt = Math.floor(Date.now() / 1_000) + 300;
    const secret = await createSession(kv, identity, expiresAt);

    expect(await readSession(kv, sessionRequest(secret))).toEqual(identity);
    const [key, value] = put.mock.calls[0] ?? [];
    expect(key).toMatch(/^web:session:[A-Za-z0-9_-]+$/u);
    expect(key).not.toContain(secret);
    const stored: unknown = JSON.parse(value ?? "null");
    expect(stored).toMatchObject({ ...identity, expiresAt });
    expect(stored).toHaveProperty("createdAt");
    expect(value).not.toContain("token");
  });

  it("expires at the access token boundary even when KV retains its record", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const kv = memoryKv();
    const put = vi.spyOn(kv, "put");
    const expiresAt = Math.floor(Date.now() / 1_000) + 10;
    const secret = await createSession(kv, identity, expiresAt);
    const serialized = put.mock.calls[0]?.[1] ?? "";
    vi.spyOn(kv, "get").mockResolvedValue(serialized);

    vi.advanceTimersByTime(9_999);
    expect(await readSession(kv, sessionRequest(secret))).toEqual(identity);
    vi.advanceTimersByTime(1);
    expect(await readSession(kv, sessionRequest(secret))).toBeNull();
  });

  it("caps the local session at eight hours for long-lived tokens", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const kv = memoryKv();
    const put = vi.spyOn(kv, "put");
    const now = Math.floor(Date.now() / 1_000);
    const secret = await createSession(kv, identity, now + SESSION_TTL_SECONDS * 2);
    const serialized = put.mock.calls[0]?.[1] ?? "";
    vi.spyOn(kv, "get").mockResolvedValue(serialized);

    expect(JSON.parse(serialized)).toMatchObject({ expiresAt: now + SESSION_TTL_SECONDS });
    vi.advanceTimersByTime(SESSION_TTL_SECONDS * 1_000);
    expect(await readSession(kv, sessionRequest(secret))).toBeNull();
  });

  it("rejects legacy records without verified-token expiry and deletes sessions on logout", async () => {
    const kv = memoryKv();
    const put = vi.spyOn(kv, "put");
    const secret = await createSession(kv, identity);
    const [key] = put.mock.calls[0] ?? [];
    expect(key).toBeDefined();
    await kv.put(key ?? "", JSON.stringify({ ...identity, createdAt: Date.now() }));
    expect(await readSession(kv, sessionRequest(secret))).toBeNull();
    await deleteSession(kv, sessionRequest(secret));
    expect(await kv.get(key ?? "")).toBeNull();
  });
});

describe("browser-bound PKCE login state", () => {
  it("returns the stored verifier, client and callback once to the bound browser", async () => {
    const kv = memoryKv();
    const put = vi.spyOn(kv, "put");
    const { state, browser } = await createLoginState(kv, login);
    expect(state).toMatch(/^web_[A-Za-z0-9_-]+$/u);
    expect(put.mock.calls[0]?.[1]).not.toContain(browser);
    expect(await consumeLoginState(kv, state, browser)).toEqual(login);
    expect(await consumeLoginState(kv, state, browser)).toBeNull();
  });

  it.each([null, "a-different-browser-cookie-123456"])(
    "refuses a callback from browser %j",
    async (browser) => {
      const kv = memoryKv();
      const { state } = await createLoginState(kv, login);
      expect(await consumeLoginState(kv, state, browser)).toBeNull();
    },
  );

  it("expires login state even if KV retains its record", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const kv = memoryKv();
    const put = vi.spyOn(kv, "put");
    const { state, browser } = await createLoginState(kv, login);
    vi.spyOn(kv, "get").mockResolvedValue(put.mock.calls[0]?.[1] ?? "");
    vi.advanceTimersByTime(LOGIN_STATE_TTL_SECONDS * 1_000 + 1);
    expect(await consumeLoginState(kv, state, browser)).toBeNull();
  });

  it.each([
    "malformed-json",
    JSON.stringify({ binding: "unknown", createdAt: Date.now() }),
    JSON.stringify({ ...login, codeVerifier: "short", binding: "unknown", createdAt: Date.now() }),
  ])("rejects malformed or pre-migration login state", async (serialized) => {
    const kv = memoryKv();
    const { state, browser } = await createLoginState(kv, login);
    await kv.put(`web:state:${state}`, serialized);
    expect(await consumeLoginState(kv, state, browser)).toBeNull();
  });
});
