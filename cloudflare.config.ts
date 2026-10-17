import { bindings, defineConfig, triggers } from "cf/config";
import manifest from "./package.json" with { type: "json" };
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
            triggers.queue({ name: "shipshape-evaluations", maxBatchSize: 5 }),
            triggers.scheduled({ schedule: "0 13 * * *" }),
          ],
    env: {
      GITHUB_API_VERSION: bindings.text("2026-03-10"),
      PUBLIC_ORIGIN: bindings.text(
        mode === "preview"
          ? ""
          : (process.env.PUBLIC_ORIGIN ??
              (mode === "development" ? process.env.PORTLESS_URL : undefined) ??
              "https://shipshape-mcp.aranlucas.workers.dev"),
      ),
      GITHUB_APP_ID: bindings.text(process.env.GITHUB_APP_ID ?? "5337206"),
      GITHUB_APP_CLIENT_ID: bindings.text(
        process.env.GITHUB_APP_CLIENT_ID ?? "Iv23liNbinuVCJJAhFVB",
      ),
      OWNER_GITHUB_ID: bindings.text(process.env.OWNER_GITHUB_ID ?? "6351530"),
      CATALOG_REPO: bindings.text(process.env.CATALOG_REPO ?? "aranlucas/practices"),
      // The App is public so it can be installed on an organization; only these
      // accounts' installations are read.
      ALLOWED_INSTALLATION_ACCOUNTS: bindings.text(
        process.env.ALLOWED_INSTALLATION_ACCOUNTS ?? "aranlucas,sidequest-labs",
      ),
      GITHUB_APP_PRIVATE_KEY: bindings.secret(),
      GITHUB_APP_CLIENT_SECRET: bindings.secret(),
      GITHUB_WEBHOOK_SECRET: bindings.secret(),
      COOKIE_ENCRYPTION_KEY: bindings.secret(),
      OAUTH_KV: bindings.kv({
        id: "9653a49921874566b41d5d4e17c88c15",
      }),
      ASSETS: bindings.assets(),
      // Preview uploads need the database ID; a name-only D1 binding is omitted.
      DB: bindings.d1({ name: "shipshape", id: manifest.config.d1DatabaseId }),
      EVALUATIONS: bindings.queue({ name: "shipshape-evaluations" }),
    },
  },
}));
