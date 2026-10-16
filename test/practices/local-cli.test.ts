import { describe, expect, it } from "vitest";
import { runCheck } from "@/practices/checks";
import { CheckSchema } from "@/practices/schema";
import { makeSnapshot, type SnapshotOptions, type SnapshotValue } from "@test/helpers/snapshot";

function evaluate(
  type: "portless-dev",
  manifest: SnapshotValue,
  options: SnapshotOptions = {},
  directory = ".",
) {
  const path = directory === "." ? "package.json" : `${directory}/package.json`;

  return runCheck(
    CheckSchema.parse({ type, directory }),
    makeSnapshot({ paths: [path], files: { [path]: JSON.stringify(manifest) }, ...options }),
    {},
  );
}

const portless = { portless: "^0.15.8" };

describe("Portless local development", () => {
  it.each([
    "portless run next dev",
    "portless run vite",
    "portless run vite --host 0.0.0.0",
    "pnpm exec portless run astro dev",
    "bun x portless run cf dev",
    "exec portless run next dev --port 3000",
  ])("accepts a default server with a local dependency: %s", (dev) => {
    expect(evaluate("portless-dev", { scripts: { dev }, devDependencies: portless }).state).toBe(
      "pass",
    );
  });

  it.each(["next dev", "vite", "pnpm exec vite", "astro dev", "cf dev", "wrangler dev"])(
    "fails a default web server bypassing Portless: %s",
    (dev) => {
      expect(
        evaluate("portless-dev", {
          scripts: { dev, "dev:portless": "portless run next dev" },
          devDependencies: portless,
        }).state,
      ).toBe("fail");
    },
  );

  it("requires a local dev dependency rather than a global or production install", () => {
    expect(evaluate("portless-dev", { scripts: { dev: "portless run vite" } }).state).toBe("fail");
    expect(
      evaluate("portless-dev", {
        scripts: { dev: "portless run vite" },
        dependencies: portless,
      }).state,
    ).toBe("fail");
  });

  it("resolves default script aliases and detects a shadowed binary", () => {
    expect(
      evaluate("portless-dev", {
        scripts: { dev: "pnpm web", web: "portless run next dev" },
        devDependencies: portless,
      }).state,
    ).toBe("pass");
    expect(
      evaluate("portless-dev", {
        scripts: { dev: "pnpm web", web: "next dev" },
        devDependencies: portless,
      }).state,
    ).toBe("fail");
    expect(
      evaluate("portless-dev", {
        scripts: { dev: "pnpm portless", portless: "vite" },
        devDependencies: portless,
      }).state,
    ).toBe("fail");
  });

  it.each([
    "node scripts/dev.mjs",
    "expo start",
    "echo 'portless run next dev'",
    "prepare && portless run next dev",
    "portless run next dev || next dev",
    "portless run vite\nnext dev",
    "portless --help",
    "portless run next dev --help",
    "portless run vite build",
    "portless run echo ready",
    "pnpm dlx portless run vite",
    "PORT=3000 portless run next dev",
  ])("keeps unsupported or non-server commands unknown: %s", (dev) => {
    expect(evaluate("portless-dev", { scripts: { dev }, devDependencies: portless }).state).toBe(
      "unknown",
    );
  });

  it("bounds cyclic and deep aliases", () => {
    expect(evaluate("portless-dev", { scripts: { dev: "pnpm dev" } }).state).toBe("unknown");

    const aliases = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`s${i}`, `pnpm s${i + 1}`]),
    );

    expect(
      evaluate("portless-dev", {
        scripts: { dev: "pnpm s0", ...aliases, s9: "portless run vite" },
        devDependencies: portless,
      }).state,
    ).toBe("unknown");
  });

  it("does not invent development scripts for libraries", () => {
    expect(evaluate("portless-dev", {})).toMatchObject({
      state: "pass",
      detail: "No scripts.dev declared; no default web server to check.",
    });
  });

  it("checks the requested workspace directory without using the root dependency", () => {
    expect(
      evaluate(
        "portless-dev",
        { scripts: { dev: "portless run vite" } },
        {
          paths: ["package.json", "apps/web/package.json"],
          files: {
            "package.json": JSON.stringify({ devDependencies: portless }),
            "apps/web/package.json": JSON.stringify({ scripts: { dev: "portless run vite" } }),
          },
        },
        "apps/web",
      ),
    ).toMatchObject({ state: "fail", path: "apps/web/package.json" });
  });
});

describe.each(["portless-dev"] as const)("%s evidence", (type) => {
  it.each<SnapshotOptions["files"]>([
    {},
    { "package.json": { error: "HTTP 403" } },
    { "package.json": { error: "Read budget exceeded" } },
    { "package.json": "{" },
    { "package.json": "null" },
    { "package.json": '{"scripts":{"dev":false}}' },
  ])("keeps unreadable and malformed manifests unknown: %j", (files) => {
    expect(evaluate(type, {}, { files }).state).toBe("unknown");
  });

  it("distinguishes missing manifests from incomplete inventories", () => {
    expect(evaluate(type, {}, { paths: [], files: {} }).state).toBe("fail");
    expect(evaluate(type, {}, { paths: [], files: {}, truncated: true }).state).toBe("unknown");
  });

  it("rejects unknown options and unsafe paths", () => {
    expect(CheckSchema.safeParse({ type, extra: true }).success).toBe(false);
    expect(CheckSchema.safeParse({ type, directory: "../private" }).success).toBe(false);
  });
});
