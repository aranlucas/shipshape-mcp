import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

const upload = ["cf", "deploy", "--prebuilt", "--mode", "production"];

const preflight = [...upload, "--dry-run"];

const pendingCheck = ["cf", "d1", "migrations", "list", databaseId, "--dir", "migrations"];

interface DeployOptions {
  script?: string;
  args?: string[];
  fail?: string;
  /** JSON printed by `cf d1 migrations list`, as the real CLI does. */
  pending?: string;
}

function deploy(options: DeployOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "shipshape-deploy-"));
  directories.push(directory);
  const bin = join(directory, "bin");
  const log = join(directory, "commands.jsonl");
  mkdirSync(bin);
  writeFileSync(log, "");
  symlinkSync(join(root, "scripts"), join(directory, "scripts"));

  const fakeCli = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
const name = basename(process.argv[1]);
const args = [name, ...process.argv.slice(2)];
appendFileSync(process.env.COMMAND_LOG, JSON.stringify(args) + "\\n");
const stage = name === "build" ? "build" : args[1] === "deploy" && args.includes("--dry-run") ? "preflight" : args[3] === "list" ? "list" : args[1];
if (stage === process.env.FAIL_COMMAND) process.exit(42);
if (stage === "list") process.stdout.write(process.env.PENDING_MIGRATIONS || "[]");
`;

  for (const name of ["cf", "build"]) {
    writeFileSync(join(bin, name), fakeCli, { mode: 0o755 });
  }

  // Exercise real pnpm script chaining; only build/upload CLIs are replaced.
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      private: true,
      config: { d1DatabaseId: databaseId },
      scripts: {
        ...manifest.scripts,
        build: "build",
      },
    }),
  );
  writeFileSync(join(directory, "pnpm-workspace.yaml"), "verifyDepsBeforeRun: false\n");

  const result = spawnSync("pnpm", ["run", options.script ?? "release", ...(options.args ?? [])], {
    cwd: directory,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      COMMAND_LOG: log,
      FAIL_COMMAND: options.fail,
      PENDING_MIGRATIONS: options.pending,
    },
    encoding: "utf8",
  });

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

describe("production release", () => {
  it("builds, validates, migrates the configured database, then deploys", () => {
    const result = deploy();
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands).toEqual([["build"], preflight, migrate, pendingCheck, upload]);
  });

  it("reuses CI artifacts while migrating before upload", () => {
    const result = deploy({ script: "release:ci" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands).toEqual([preflight, migrate, pendingCheck, upload]);
  });

  it("stops before migration when the build fails", () => {
    const result = deploy({ fail: "build" });
    expect(result.status).toBe(42);
    expect(result.commands).toEqual([["build"]]);
  });

  it("stops before upload when migration fails", () => {
    const result = deploy({ script: "release:ci", fail: "d1" });
    expect(result.status).toBe(42);
    expect(result.commands).toEqual([preflight, migrate]);
  });

  it("propagates upload failures", () => {
    const result = deploy({ script: "release:ci", fail: "deploy" });
    expect(result.status).toBe(42);
    expect(result.commands).toEqual([preflight, migrate, pendingCheck, upload]);
  });

  it("stops before database writes or upload when Cloudflare rejects the artifact", () => {
    const result = deploy({ script: "release:ci", fail: "preflight" });
    expect(result.status).toBe(42);
    expect(result.commands).toEqual([preflight]);
  });
});

describe("ordinary Cloudflare commands", () => {
  it("deploys the existing artifact without building or migrating", () => {
    const result = deploy({ script: "deploy" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands).toEqual([pendingCheck, upload]);
  });

  it("refuses to upload while production has unapplied migrations", () => {
    const result = deploy({
      script: "deploy",
      pending: '[\n  {\n    "Name": "0005_built_in_practices.sql"\n  }\n]',
    });

    expect(result.status).toBe(1);
    expect(result.commands).toEqual([pendingCheck]);
    expect(result.stderr).toContain("0005_built_in_practices.sql");
    expect(result.stderr).toContain("pnpm release:ci");
  });

  it("refuses to upload when the pending check itself fails", () => {
    const result = deploy({ script: "deploy", fail: "list" });
    expect(result.status).toBe(42);
    expect(result.commands).toEqual([pendingCheck]);
  });

  it.each(["dry-run", "deploy"])("never migrates during a %s dry run", (script) => {
    const result = deploy({ script, args: script === "deploy" ? ["--dry-run"] : [] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands).toEqual([
      ...(script === "dry-run" ? [["build"]] : []),
      [...upload, "--dry-run"],
    ]);
  });

  it("leaves deployment options to the Cloudflare CLI", () => {
    const args = ["--profile", "production", "--secrets-file", "app-secrets.json", "--tag", "v1"];
    const result = deploy({ script: "deploy", args });
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands).toEqual([
      [...pendingCheck, "--profile", "production"],
      [...upload, ...args],
    ]);
  });

  it("checks pending migrations with an inline --profile= value", () => {
    const result = deploy({ script: "deploy", args: ["--profile=production"] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands).toEqual([
      [...pendingCheck, "--profile=production"],
      [...upload, "--profile=production"],
    ]);
  });

  it("can migrate with an explicit auth profile", () => {
    const result = deploy({ script: "db:migrate", args: ["--profile", "production"] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands).toEqual([[...migrate, "--profile", "production"]]);
  });
});
