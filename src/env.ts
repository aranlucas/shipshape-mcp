import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { OAuthStateStore } from "./oauth-security";

export interface EvaluationMessage {
  /** Missing only on messages published before durable jobs were deployed. */
  jobId?: string;
  repo: string;
  installationId: number;
  reason: "push" | "catalog" | "sweep" | "manual" | "installation";
  /** Retries target one practice without repeating completed evaluations. */
  practiceId?: string;
}

export interface AppEnv {
  OAUTH_KV: OAuthStateStore & KVNamespace;
  OAUTH_PROVIDER: Pick<OAuthHelpers, "parseAuthRequest" | "lookupClient" | "completeAuthorization">;
  /** Static dashboard bundle (public/app); absent in unit tests. */
  ASSETS?: Fetcher;
  DB: D1Database;
  EVALUATIONS: Queue<EvaluationMessage>;
  WEBHOOKS: Queue<WebhookMessage>;
  PREVIEW_READ_ONLY?: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_CLIENT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  OWNER_GITHUB_ID: string;
  CATALOG_REPO: string;
  /** Comma-separated GitHub accounts whose App installations Shipshape reads. */
  ALLOWED_INSTALLATION_ACCOUNTS: string;
  COOKIE_ENCRYPTION_KEY?: string;
  GITHUB_API_VERSION?: string;
  PUBLIC_ORIGIN?: string;
}

export type WebhookMessage =
  | {
      deliveryId: string;
      event: "push";
      repository: string;
      installationId: number;
      ref: string;
      defaultBranch: string;
    }
  | { deliveryId: string; event: "repository"; repository: string; installationId: number }
  | { deliveryId: string; event: "installation" | "installation_repositories" };
