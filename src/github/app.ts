import { z } from "zod";
import type { AppEnv } from "../env";
import { createGitHubOctokit, type GitHubOctokit } from "./client";

const encoder = new TextEncoder();

const tokenSchema = z.object({ token: z.string(), expires_at: z.iso.datetime() });

const base64Url = (input: string | ArrayBuffer | Uint8Array) => {
  const bytes =
    input instanceof Uint8Array || input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : encoder.encode(input);

  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll(/=+$/gu, "");
};

export class InstallationUnavailableError extends Error {
  constructor(public readonly installationId: number) {
    super(`GitHub installation ${installationId} is unavailable`);
    this.name = "InstallationUnavailableError";
  }
}

export async function createAppJwt(
  appId: string,
  pkcs8Pem: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  if (pkcs8Pem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY must be PKCS#8. Convert it with: openssl pkcs8 -topk8 -nocrypt -in app.pem",
    );
  }

  const der = Uint8Array.from(
    atob(pkcs8Pem.replaceAll(/-----[^-]+-----|\\n|\s/gu, "")),
    (c) => c.codePointAt(0) ?? 0,
  );

  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));

  const payload = base64Url(
    JSON.stringify({ iss: appId, iat: nowSeconds - 60, exp: nowSeconds + 540 }),
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(`${header}.${payload}`),
  );

  return `${header}.${payload}.${base64Url(signature)}`;
}

export async function installationToken(env: AppEnv, installationId: number): Promise<string> {
  const cacheKey = `app:installation-token:${installationId}`;
  const cached = await env.OAUTH_KV.get(cacheKey);

  if (cached) {
    return cached;
  }

  const jwt = await createAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);

  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" },
    },
  );

  if (response.status === 404) {
    throw new InstallationUnavailableError(installationId);
  }

  if (!response.ok) {
    throw new Error(`GitHub installation token request failed: ${response.status}`);
  }

  const parsed = tokenSchema.parse(await response.json());
  const ttl = Math.max(1, Math.floor((Date.parse(parsed.expires_at) - Date.now()) / 1000) - 300);
  await env.OAUTH_KV.put(cacheKey, parsed.token, { expirationTtl: ttl });

  return parsed.token;
}

export async function installationClient(
  env: AppEnv,
  installationId: number,
): Promise<GitHubOctokit> {
  return createGitHubOctokit(await installationToken(env, installationId));
}

export async function appClient(env: AppEnv): Promise<GitHubOctokit> {
  return createGitHubOctokit(await createAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY));
}
