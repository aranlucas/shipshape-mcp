import { applyD1Migrations, env } from "cloudflare:test";

interface TestEnv extends Cloudflare.Env {
  TEST_MIGRATIONS: string;
}

// SAFETY: TEST_MIGRATIONS is always configured as JSON by vitest.config.ts.
const migrations = (env as TestEnv).TEST_MIGRATIONS;

// SAFETY: the configured JSON is produced by readD1Migrations and matches D1Migration[].
const parsed = JSON.parse(migrations) as Parameters<typeof applyD1Migrations>[1];

await applyD1Migrations(env.DB, parsed);
