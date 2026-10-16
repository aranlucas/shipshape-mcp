import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const root = resolve(import.meta.dirname, "..");

const manifest = z
  .object({ scripts: z.record(z.string(), z.string()) })
  .parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));

const directories: string[] = [];

const databaseId = "11111111-1111-4111-8111-111111111111";

const migrate = ["cf", "d1", "migrations", "apply", databaseId, "--dir", "migrations"];

interface DeployOptions {
  script?: string;
  args?: string[];
  fail?: string;
  preview?: boolean;
  missingDatabase?: boolean;
}

function deploy(options: DeployOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "shipshape-deploy-"));
  directories.push(directory);
  const bin = join(directory, "bin");
  const output = join(directory, ".cloudflare/output/v0");
  const log = join(directory, "commands.jsonl");
  mkdirSync(bin);
  mkdirSync(join(output, "workers/default"), { recursive: true });
  writeFileSync(log, "");
  writeFileSync(
    join(output, "config.json"),
    JSON.stringify({
      buildContext: {
        mode: options.preview ? "preview" : "production",
        isPreview: !!options.preview,
      },
    }),
  );
  writeFileSync(
    join(output, "workers/default/worker.config.json"),
    JSON.stringify({
      env: { DB: options.missingDatabase ? { type: "d1" } : { type: "d1", id: databaseId } },
    }),
  );

  const fakeCli = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
const args = [basename(process.argv[1]), ...process.argv.slice(2)];
appendFileSync(process.env.COMMAND_LOG, JSON.stringify(args) + "\\n");
if (args[1] === process.env.FAIL_COMMAND) process.exit(42);
`;

  for (const name of ["cf", "pnpm"]) {
    writeFileSync(join(bin, name), fakeCli, { mode: 0o755 });
  }

  const [command = "", ...args] = (manifest.scripts[options.script ?? "deploy"] ?? "").split(" ");

  // Run the real package entrypoint with fake CLIs and no Cloudflare credentials.
  const result = spawnSync(
    command === "node" ? process.execPath : command,
    command === "node"
      ? [resolve(root, args[0] ?? ""), ...args.slice(1), ...(options.args ?? [])]
      : [...args, ...(options.args ?? [])],
    {
      cwd: directory,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        COMMAND_LOG: log,
        FAIL_COMMAND: options.fail,
      },
      encoding: "utf8",
    },
  );

  const commands = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => z.array(z.string()).parse(JSON.parse(line)));

  return { status: result.status, stderr: result.stderr, commands };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("production deployment", () => {
  it("builds, migrates the database from the build output, then deploys", () => {
    const result = deploy();
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands).toEqual([["pnpm", "build"], migrate, ["cf", "deploy", "--prebuilt"]]);
  });

  it("also migrates before deploying prebuilt CI artifacts", () => {
    const result = deploy({ script: "deploy:ci" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands).toEqual([migrate, ["cf", "deploy", "--prebuilt"]]);
  });

  it("stops before migration when the build fails", () => {
    const result = deploy({ fail: "build" });
    expect(result.status).toBe(42);
    expect(result.commands).toEqual([["pnpm", "build"]]);
  });

  it("stops before upload when migration fails", () => {
    const result = deploy({ fail: "d1" });
    expect(result.status).toBe(42);
    expect(result.commands).toEqual([["pnpm", "build"], migrate]);
  });

  it("propagates upload failures", () => {
    const result = deploy({ script: "deploy:ci", fail: "deploy" });
    expect(result.status).toBe(42);
    expect(result.commands).toEqual([migrate, ["cf", "deploy", "--prebuilt"]]);
  });

  it("rejects target overrides before running any commands", () => {
    const result = deploy({ args: ["--worker", "another-worker"] });
    expect(result.status).not.toBe(0);
    expect(result.commands).toEqual([]);
  });

  it.each(["dry-run", "deploy"])("never migrates during a %s dry run", (script) => {
    const result = deploy({ script, args: script === "deploy" ? ["--dry-run"] : [] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands).toEqual([
      ["pnpm", "build"],
      ["cf", "deploy", "--prebuilt", "--dry-run"],
    ]);
  });

  it("uses the same auth profile for migration and deployment and forwards secrets", () => {
    const result = deploy({
      args: ["--profile", "production", "--secrets-file", "app-secrets.json"],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.commands).toEqual([
      ["pnpm", "build"],
      [...migrate, "--profile", "production"],
      [
        "cf",
        "deploy",
        "--prebuilt",
        "--profile",
        "production",
        "--secrets-file",
        "app-secrets.json",
      ],
    ]);
  });

  it.each([{ preview: true }, { missingDatabase: true }])(
    "refuses unsafe build output: %j",
    (options) => {
      const result = deploy({ script: "deploy:ci", ...options });
      expect(result.status).not.toBe(0);
      expect(result.commands).toEqual([]);
    },
  );
});
