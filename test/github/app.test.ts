import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppJwt, InstallationUnavailableError, installationToken } from "@/github/app";
import type { AppEnv } from "@/env";
import { TEST_PRIVATE_KEY_PEM, TEST_PUBLIC_KEY_PEM } from "@test/helpers/app-key";

interface TestKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: PutOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

interface PutOptions {
  expirationTtl?: number;
}

function createTestEnv(kv: TestKv, apiVersion?: string): AppEnv {
  // SAFETY: this fixture only exercises App JWT and KV behavior; unrelated bindings are inert.
  return {
    OAUTH_KV: kv as AppEnv["OAUTH_KV"],
    OAUTH_PROVIDER: {} as AppEnv["OAUTH_PROVIDER"],
    DB: {} as D1Database,
    EVALUATIONS: {} as Queue<never>,
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
    GITHUB_APP_CLIENT_ID: "synthetic-client",
    GITHUB_APP_CLIENT_SECRET: "synthetic-secret",
    GITHUB_WEBHOOK_SECRET: "synthetic-webhook-secret",
    OWNER_GITHUB_ID: "1001",
    CATALOG_REPO: "owner/repository",
    ALLOWED_INSTALLATION_ACCOUNTS: "owner",
    GITHUB_API_VERSION: apiVersion,
  };
}

function decode(part: string): Record<string, string | number> {
  // SAFETY: JWT header and payload are JSON objects created by createAppJwt.
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<
    string,
    string | number
  >;
}

function pemBytes(pem: string): ArrayBuffer {
  const bytes = Buffer.from(pem.replaceAll(/-----[^-]+-----|\s/gu, ""), "base64");
  const result = new ArrayBuffer(bytes.byteLength);

  new Uint8Array(result).set(bytes);

  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createAppJwt", () => {
  it("signs an RS256 JWT with exact GitHub timing claims", async () => {
    const jwt = await createAppJwt("12345", TEST_PRIVATE_KEY_PEM, 1_800_000_000);
    const [header = "", payload = "", signature = ""] = jwt.split(".");

    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(payload)).toEqual({
      iss: "12345",
      iat: 1_799_999_940,
      exp: 1_800_000_540,
    });

    const key = await crypto.subtle.importKey(
      "spki",
      pemBytes(TEST_PUBLIC_KEY_PEM),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      Buffer.from(signature, "base64url"),
      new TextEncoder().encode(`${header}.${payload}`),
    );

    expect(verified).toBe(true);
  });

  it("rejects PKCS#1 keys with conversion guidance", async () => {
    const rsaLabel = "RSA";
    const marker = `-----BEGIN ${rsaLabel} PRIVATE KEY-----`;

    await expect(
      createAppJwt("1", `${marker}\nAAAA\n-----END ${rsaLabel} PRIVATE KEY-----`),
    ).rejects.toThrow(/openssl pkcs8 -topk8/);
  });
});

describe("installationToken", () => {
  it("POSTs a JWT request, caches the token, and uses the exact safety TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2029-12-31T23:00:00.000Z"));

    const values = new Map<string, string>();

    const put = vi.fn((key: string, value: string, _options?: PutOptions) => {
      values.set(key, value);

      return Promise.resolve();
    });

    const kv: TestKv = {
      get: (key) => Promise.resolve(values.get(key) ?? null),
      put,
      delete: () => Promise.resolve(),
    };

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ token: "installation-token", expires_at: "2030-01-01T00:00:00Z" }),
          { status: 201 },
        ),
      );

    const env = createTestEnv(kv, "2025-01-01");
    const first = await installationToken(env, 42);
    const second = await installationToken(env, 42);
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    const authorization = headers.get("Authorization");

    expect(first).toBe("installation-token");
    expect(second).toBe("installation-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(input).toBe("https://api.github.com/app/installations/42/access_tokens");
    expect(init?.method).toBe("POST");
    expect(authorization).toMatch(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    expect(headers.get("User-Agent")).toBe("shipshape-mcp");
    expect(headers.get("X-GitHub-Api-Version")).toBe("2025-01-01");
    expect(values.get("app:installation-token:42")).toBe("installation-token");
    expect(put).toHaveBeenCalledWith("app:installation-token:42", "installation-token", {
      expirationTtl: 3_300,
    });
  });

  it("throws InstallationUnavailableError with the installation ID on a 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));

    const kv: TestKv = {
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    };

    await expect(installationToken(createTestEnv(kv), 99)).rejects.toBeInstanceOf(
      InstallationUnavailableError,
    );
    await expect(installationToken(createTestEnv(kv), 99)).rejects.toMatchObject({
      installationId: 99,
    });
  });
});
