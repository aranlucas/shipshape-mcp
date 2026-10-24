import { bindings, defineConfig, triggers } from "cf/config";
import manifest from "./package.json" with { type: "json" };
import * as entrypoint from "./src/index" with { type: "cf-worker" };
import { deploymentResources } from "./src/deployment-resources.ts";

export default defineConfig(({ mode }) => {
  const resources = deploymentResources(mode ?? "production", manifest.config, process.env);

  return {
    worker: {
      name: "shipshape-mcp",
      compatibilityDate: "2026-08-30",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      entrypoint,
      observability: {
        enabled: true,
        logs: {
          enabled: true,
          headSamplingRate: 1,
          invocationLogs: true,
        },
        traces: {
          enabled: true,
          headSamplingRate: 0.05,
        },
      },
      assets: {
        // Hashed bundles are public; the HTML shell and API go through the Worker's session check.
        runWorkerFirst: ["/app", "/app/*", "!/app/assets/*"],
      },
      // Preview uploads reject the triggers field, so previews (built with
      // `--mode preview`) serve requests but never consume the queue or run the sweep.
      triggers:
        mode === "preview"
          ? undefined
          : [
              triggers.queue({
                name: "shipshape-evaluations",
                maxBatchSize: 5,
                maxConcurrency: 1,
                maxRetries: 3,
                deadLetterQueue: "shipshape-evaluations-failed",
              }),
              triggers.queue({
                name: "shipshape-webhooks",
                maxBatchSize: 1,
                maxConcurrency: 1,
                maxRetries: 5,
                deadLetterQueue: "shipshape-webhooks-failed",
              }),
              triggers.scheduled({ schedule: "0 13 * * *" }),
              triggers.scheduled({ schedule: "* * * * *" }),
            ],
      env: {
        GITHUB_API_VERSION: bindings.text("2026-03-10"),
        PREVIEW_READ_ONLY: bindings.text(resources.readOnly),
        PUBLIC_ORIGIN: bindings.text(
          mode === "preview"
            ? ""
            : (process.env.PUBLIC_ORIGIN ??
                (mode === "development" ? process.env.PORTLESS_URL : undefined) ??
                "https://shipshape-mcp.aranlucas.workers.dev"),
        ),
        GITHUB_APP_ID: bindings.text(process.env.GITHUB_APP_ID ?? "5337206"),
        BETTER_AUTH_ISSUER: bindings.text(
          process.env.BETTER_AUTH_ISSUER ?? "https://auth.aranlucas.workers.dev/api/auth",
        ),
        BETTER_AUTH_JWKS_URL: bindings.text(
          process.env.BETTER_AUTH_JWKS_URL ?? "https://auth.aranlucas.workers.dev/api/auth/jwks",
        ),
        MCP_ALLOWED_ORIGINS: bindings.text(process.env.MCP_ALLOWED_ORIGINS ?? "[]"),
        OWNER_GITHUB_ID: bindings.text(process.env.OWNER_GITHUB_ID ?? "6351530"),
        CATALOG_REPO: bindings.text(process.env.CATALOG_REPO ?? "aranlucas/practices"),
        // The App is public so it can be installed on an organization; only these
        // accounts' installations are read.
        ALLOWED_INSTALLATION_ACCOUNTS: bindings.text(
          process.env.ALLOWED_INSTALLATION_ACCOUNTS ?? "aranlucas,sidequest-labs",
        ),
        GITHUB_APP_PRIVATE_KEY: bindings.secret(),
        GITHUB_WEBHOOK_SECRET: bindings.secret(),
        // Retains its deployed name: caches installation tokens, dashboard clients and sessions.
        OAUTH_KV: bindings.kv({
          id: resources.kvId,
        }),
        ASSETS: bindings.assets(),
        // Preview uploads need the database ID; a name-only D1 binding is omitted.
        DB: bindings.d1({ name: resources.prefix, id: resources.databaseId }),
        EVALUATIONS: bindings.queue({ name: `${resources.prefix}-evaluations` }),
        WEBHOOKS: bindings.queue({ name: `${resources.prefix}-webhooks` }),
      },
    },
  };
});
