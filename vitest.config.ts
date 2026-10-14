import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["test/**/*.test.ts"],
          exclude: ["test/workers/**"],
        },
      },
      {
        extends: true,
        plugins: [
          cloudflareTest({
            experimental: { newConfig: true },
            miniflare: {
              bindings: {
                GITHUB_CLIENT_ID: "synthetic-client",
                GITHUB_CLIENT_SECRET: "synthetic-secret",
                COOKIE_ENCRYPTION_KEY: "synthetic-cookie-key",
              },
            },
          }),
        ],
        test: {
          name: "workers",
          include: ["test/workers/**/*.test.ts"],
        },
      },
    ],
  },
});
