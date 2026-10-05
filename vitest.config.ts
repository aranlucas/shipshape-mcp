import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/workers/**"],
        },
      },
      {
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
          include: ["tests/workers/**/*.test.ts"],
        },
      },
    ],
  },
});
