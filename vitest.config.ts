import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { TEST_PRIVATE_KEY_PEM } from "./test/helpers/app-key.ts";

const testMigrations = await readD1Migrations("./migrations");

export default defineConfig({
  resolve: { tsconfigPaths: true, alias: { react: "preact/compat" } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          server: { deps: { inline: ["@tanstack/react-query"] } },
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
                GITHUB_APP_ID: "12345",
                GITHUB_APP_CLIENT_ID: "Iv1.synthetic",
                GITHUB_APP_CLIENT_SECRET: "synthetic-secret",
                GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
                GITHUB_WEBHOOK_SECRET: "synthetic-webhook-secret",
                OWNER_GITHUB_ID: "1001",
                CATALOG_REPO: "aranlucas/practices",
                ALLOWED_INSTALLATION_ACCOUNTS: "aranlucas,sidequest-labs",
                COOKIE_ENCRYPTION_KEY: "synthetic-cookie-key",
                TEST_MIGRATIONS: JSON.stringify(testMigrations),
              },
            },
          }),
        ],
        resolve: {
          alias: [
            {
              find: /^\.\/built-in-sources$/u,
              replacement: fileURLToPath(
                new URL("./test/helpers/no-built-in-sources.ts", import.meta.url),
              ),
            },
          ],
        },
        test: {
          name: "workers",
          include: ["test/workers/**/*.test.ts"],
          setupFiles: ["./test/workers/setup.ts"],
        },
      },
    ],
  },
});
