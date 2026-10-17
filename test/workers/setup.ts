import { beforeEach } from "vitest";
import { applyD1Migrations, env } from "cloudflare:test";

interface TestEnv extends Cloudflare.Env {
  TEST_MIGRATIONS: string;
}

// SAFETY: TEST_MIGRATIONS is always configured as JSON by vitest.config.ts.
const migrations = (env as TestEnv).TEST_MIGRATIONS;

// SAFETY: the configured JSON is produced by readD1Migrations and matches D1Migration[].
const parsed = JSON.parse(migrations) as Parameters<typeof applyD1Migrations>[1];

await applyD1Migrations(env.DB, parsed);

// Keep cleanup independent of a test's deliberate DB.prepare failure injection.
const prepare = env.DB.prepare.bind(env.DB);

const batch = env.DB.batch.bind(env.DB);

// Job state spans deliveries within a test, but must not leak into the next test.
beforeEach(async () => {
  await batch([
    prepare("DELETE FROM evaluation_jobs"),
    prepare("DELETE FROM evaluation_heads"),
    prepare("DELETE FROM evaluation_runs"),
  ]);
});
