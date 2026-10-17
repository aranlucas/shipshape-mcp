import { spawnSync } from "node:child_process";
import { z } from "zod";

// `cf deploy` for an existing production artifact, refusing to upload while the
// production database has unapplied migrations: new code against an old schema
// fails every request. Arguments pass through to `cf deploy` unchanged.

const args = process.argv.slice(2);

const PendingMigrations = z.array(z.object({ Name: z.string() }));

function run(command: string, commandArgs: string[], capture = false) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    stdio: ["inherit", capture ? "pipe" : "inherit", "inherit"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  return result.stdout ?? "";
}

/** The `--profile` the deployment uses, so the check reads the same account. */
function profileArgs(): string[] {
  const index = args.findIndex((arg) => arg === "--profile" || arg.startsWith("--profile="));

  if (index === -1) {
    return [];
  }

  const flag = args[index] ?? "";

  return flag.includes("=") ? [flag] : [flag, args[index + 1] ?? ""];
}

// A dry run uploads nothing, so it stays offline (`pnpm check` runs one in CI).
if (!args.includes("--dry-run")) {
  const databaseId = process.env.npm_package_config_d1DatabaseId;

  if (!databaseId) {
    process.stderr.write("Run this through `pnpm run deploy` so config.d1DatabaseId is set.\n");
    process.exit(1);
  }

  const output = run(
    "cf",
    ["d1", "migrations", "list", databaseId, "--dir", "migrations", ...profileArgs()],
    true,
  );

  // `cf d1 migrations list` prints the unapplied migrations as JSON and exits 0 either way.
  const pending = PendingMigrations.parse(JSON.parse(output));

  if (pending.length > 0) {
    const names = pending.map((migration) => migration.Name);

    process.stderr.write(
      `Refusing to deploy: production D1 has ${names.length} unapplied migration(s): ${names.join(", ")}.\n` +
        "Deploy with `pnpm release:ci` (or `pnpm release`), which applies migrations first, " +
        "or run `pnpm db:migrate` and deploy again.\n",
    );
    process.exit(1);
  }
}

run("cf", ["deploy", "--prebuilt", "--mode", "production", ...args]);
