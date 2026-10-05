import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "shipshape-mcp",
    compatibilityDate: "2026-08-30",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    entrypoint: "src/index.ts",
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
    env: {
      GITHUB_API_VERSION: bindings.text("2026-03-10"),
      PUBLIC_ORIGIN: bindings.text(
        "https://shipshape-mcp.aranlucas.workers.dev",
      ),
      GITHUB_CLIENT_ID: bindings.secret(),
      GITHUB_CLIENT_SECRET: bindings.secret(),
      COOKIE_ENCRYPTION_KEY: bindings.secret(),
      OAUTH_KV: bindings.kv({
        id: "9653a49921874566b41d5d4e17c88c15",
      }),
    },
  },
});
