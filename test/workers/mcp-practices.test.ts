/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/require-safety-comment-for-type-assertion */

import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";

import type { AppEnv } from "@/env";
import { createPracticesServer } from "@/mcp";
import { parsePractice } from "@/practices/schema";
import {
  upsertRepositories,
  writeCatalog,
  writeResults,
  type StoredRepository,
} from "@/practices/store";
import {
  OverviewResponseSchema,
  PracticeDetailResponseSchema,
  RepoDetailResponseSchema,
} from "@test/helpers/contract-schemas";

const appEnv = env as AppEnv;
const catalogSha = "a".repeat(40);

const validYaml = `version: 1
id: husky
title: Husky hooks
summary: Keep hooks configured
kind: files
checks:
  - type: file-exists
    path: .husky/pre-commit
`;

const brokenYaml = `version: 1
id: broken
title: Broken
summary: Invalid check
kind: files
checks:
  - type: file-exist
    path: README.md
`;

function repository(fullName: string): StoredRepository {
  const [owner = "owner", name = "repo"] = fullName.split("/");

  return {
    fullName,
    owner,
    name,
    installationId: 1,
    private: false,
    archived: false,
    fork: false,
    language: "TypeScript",
    defaultBranch: "main",
    pushedAt: "2026-10-15T12:00:00.000Z",
    url: `https://github.com/${fullName}`,
  };
}

function practice(id: string, yaml: string, files: Record<string, string> = {}) {
  return {
    id,
    folder: id,
    yaml,
    instructions: id === "husky" ? "Install the hook." : null,
    files,
    parsed: parsePractice(yaml, id),
  };
}

async function seed() {
  await appEnv.DB.batch([
    appEnv.DB.prepare("DELETE FROM results"),
    appEnv.DB.prepare("DELETE FROM catalog"),
    appEnv.DB.prepare("DELETE FROM repositories"),
    appEnv.DB.prepare("UPDATE sweep SET pending = 0, last_completed_at = NULL WHERE id = 1"),
  ]);

  await upsertRepositories(
    appEnv.DB,
    [repository("aranlucas/alpha"), repository("aranlucas/zeta"), repository("other/repo")],
    "2026-10-15T12:00:00.000Z",
  );
  await writeCatalog(
    appEnv.DB,
    {
      repo: "aranlucas/practices",
      sha: catalogSha,
      practices: [
        practice("husky", validYaml, { "files/pre-commit": "#!/bin/sh\n" }),
        practice("broken", brokenYaml),
      ],
    },
    "2026-10-15T12:00:00.000Z",
  );
  await writeResults(appEnv.DB, [
    {
      repo: "aranlucas/alpha",
      practiceId: "husky",
      cell: { state: "fail", checkedAt: "2026-10-15T12:30:00.000Z", failing: 1, unknown: 0 },
      checks: [],
      headSha: "h".repeat(40),
      catalogSha,
    },
    {
      repo: "aranlucas/zeta",
      practiceId: "broken",
      cell: { state: "unknown", checkedAt: null, failing: 0, unknown: 1 },
      checks: [],
      headSha: null,
      catalogSha,
    },
  ]);
}

async function connect() {
  const server = createPracticesServer(appEnv);
  const client = new Client({ name: "offline-practices", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server };
}

function jsonPayload(result: Awaited<ReturnType<Client["callTool"]>>) {
  expect(result.isError).not.toBe(true);
  expect(result.content).toHaveLength(1);
  expect(result.content[0]?.type).toBe("text");
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  expect(result.structuredContent).toEqual(JSON.parse(text));
  return result.structuredContent;
}

describe("practice MCP tools", () => {
  beforeEach(seed);

  it("lists exactly three read-only tools with structured JSON text results", async () => {
    const { client, server } = await connect();

    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).toSorted()).toEqual([
        "practice_detail",
        "practices_overview",
        "repo_practices",
      ]);
      for (const tool of tools) {
        expect(tool.annotations).toEqual({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        });
      }

      const result = await client.callTool({ name: "practices_overview", arguments: {} });
      const payload = OverviewResponseSchema.parse(jsonPayload(result));
      expect(payload.catalog).toEqual({
        repo: "aranlucas/practices",
        sha: catalogSha,
        loadedAt: "2026-10-15T12:00:00.000Z",
        disabled: [],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("filters overview repos and cells by owner and state", async () => {
    const { client, server } = await connect();

    try {
      const result = await client.callTool({
        name: "practices_overview",
        arguments: { owner: "aranlucas", state: "fail" },
      });
      const payload = OverviewResponseSchema.parse(jsonPayload(result));

      expect(payload.repos.map((repo) => repo.fullName)).toEqual(["aranlucas/alpha"]);
      expect(Object.keys(payload.results)).toEqual(["aranlucas/alpha"]);
      expect(payload.results["aranlucas/alpha"]?.husky?.state).toBe("fail");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns strict repo and practice detail contracts and maps unknown repos to tool errors", async () => {
    const { client, server } = await connect();

    try {
      const repo = await client.callTool({
        name: "repo_practices",
        arguments: { owner: "aranlucas", repo: "alpha" },
      });
      const repoPayload = RepoDetailResponseSchema.parse(jsonPayload(repo));
      expect(repoPayload.repo.fullName).toBe("aranlucas/alpha");

      const detail = await client.callTool({
        name: "practice_detail",
        arguments: { id: "husky" },
      });
      const detailPayload = PracticeDetailResponseSchema.parse(jsonPayload(detail));
      expect(detailPayload.practice.id).toBe("husky");

      const missing = await client.callTool({
        name: "repo_practices",
        arguments: { owner: "aranlucas", repo: "missing" },
      });
      expect(missing.isError).toBe(true);
      expect(missing.content).toEqual([{ type: "text", text: "Repository not found" }]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
