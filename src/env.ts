import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { OAuthStateStore } from "./oauth-security";

export interface EvaluationMessage {
  repo: string;
  installationId: number;
  reason: "push" | "catalog" | "sweep" | "manual" | "installation";
}

export interface AppEnv {
  OAUTH_KV: OAuthStateStore & KVNamespace;
  OAUTH_PROVIDER: Pick<OAuthHelpers, "parseAuthRequest" | "lookupClient" | "completeAuthorization">;
  /** Static dashboard bundle (public/app); absent in unit tests. */
  ASSETS?: Fetcher;
  DB: D1Database;
  EVALUATIONS: Queue<EvaluationMessage>;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_CLIENT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  OWNER_GITHUB_ID: string;
  CATALOG_REPO: string;
  COOKIE_ENCRYPTION_KEY?: string;
  GITHUB_API_VERSION?: string;
  PUBLIC_ORIGIN?: string;
}
