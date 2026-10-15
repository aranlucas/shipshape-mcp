import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index" with { type: "cf-worker" };

export default defineConfig(({ mode }) => ({
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
    triggers: [
      triggers.queue({ name: "shipshape-evaluations", maxBatchSize: 5 }),
      triggers.scheduled({ schedule: "0 13 * * *" }),
    ],
    env: {
      GITHUB_API_VERSION: bindings.text("2026-03-10"),
      PUBLIC_ORIGIN: bindings.text(
        mode === "development" && process.env.PORTLESS_URL
          ? process.env.PORTLESS_URL
          : "https://shipshape-mcp.aranlucas.workers.dev",
      ),
      GITHUB_APP_ID: bindings.text(process.env.GITHUB_APP_ID ?? "0"),
      GITHUB_APP_CLIENT_ID: bindings.text(process.env.GITHUB_APP_CLIENT_ID ?? "unset"),
      OWNER_GITHUB_ID: bindings.text(process.env.OWNER_GITHUB_ID ?? "0"),
      CATALOG_REPO: bindings.text("aranlucas/practices"),
      GITHUB_APP_PRIVATE_KEY: bindings.secret(),
      GITHUB_APP_CLIENT_SECRET: bindings.secret(),
      GITHUB_WEBHOOK_SECRET: bindings.secret(),
      COOKIE_ENCRYPTION_KEY: bindings.secret(),
      OAUTH_KV: bindings.kv({
        id: "9653a49921874566b41d5d4e17c88c15",
      }),
      DB: bindings.d1({ name: "shipshape" }),
      EVALUATIONS: bindings.queue({ name: "shipshape-evaluations" }),
    },
  },
}));
