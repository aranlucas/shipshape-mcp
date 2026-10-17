import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";

const { values } = parseArgs({
  options: {
    prebuilt: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    profile: { type: "string" },
    "secrets-file": { type: "string" },
    tag: { type: "string" },
    message: { type: "string" },
  },
});

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// Workers Builds already ran the configured build command before deployment.
if (!values.prebuilt && process.env.WORKERS_CI !== "1") {
  run("pnpm", ["build"]);
}

const output = ".cloudflare/output/v0";

// Read the artifact being deployed so migration and Worker use the same database.
z.object({
  buildContext: z.object({ mode: z.literal("production"), isPreview: z.literal(false) }),
}).parse(JSON.parse(readFileSync(`${output}/config.json`, "utf8")));

const worker = z
  .object({
    env: z.object({ DB: z.object({ type: z.literal("d1"), id: z.uuid() }) }),
  })
  .parse(JSON.parse(readFileSync(`${output}/workers/default/worker.config.json`, "utf8")));

const profile = values.profile ? ["--profile", values.profile] : [];

if (!values["dry-run"]) {
  run("cf", ["d1", "migrations", "apply", worker.env.DB.id, "--dir", "migrations", ...profile]);
}

const deployArgs = ["deploy", "--prebuilt", ...profile];

if (values["dry-run"]) {
  deployArgs.push("--dry-run");
}

for (const option of ["secrets-file", "tag", "message"] as const) {
  const value = values[option];

  if (value !== undefined) {
    deployArgs.push(`--${option}`, value);
  }
}

run("cf", deployArgs);
