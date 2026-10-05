import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { createPortfolioServer } from "../src/mcp";
import { createGitHubOctokit } from "../src/github/client";
import { fullRoute, jsonResponse, repository } from "./helpers/github-fixtures";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function connect(
  route: (url: URL) => Response | Promise<Response> = auditRoute,
) {
  const calls: URL[] = [];

  const github = createGitHubOctokit("synthetic-token", async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.github.com");
    expect(init?.method ?? "GET").toBe("GET");
    calls.push(url);
    const response = await route(url);
    Object.defineProperty(response, "url", { value: url.href });

    return response;
  });

  const server = createPortfolioServer(() => github);
  const client = new Client({ name: "offline-integration", version: "1.0.0" });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, calls };
}

function auditRoute(url: URL): Response {
  if (url.pathname === "/repos/octo/demo/commits/main")
    return jsonResponse({ sha: "a".repeat(40) });

  if (url.pathname === `/repos/octo/demo/git/trees/${"a".repeat(40)}`) {
    return jsonResponse({
      truncated: false,
      tree: [
        {
          path: ".shipshape.yml",
          sha: "b".repeat(40),
          mode: "100644",
          type: "blob",
          size: 35,
        },
        {
          path: "package.json",
          sha: "c".repeat(40),
          mode: "100644",
          type: "blob",
          size: 2,
        },
      ],
    });
  }

  if (url.pathname === `/repos/octo/demo/git/blobs/${"b".repeat(40)}`) {
    const text = "baseline: shipshape/recommended@1";

    return jsonResponse({
      encoding: "base64",
      content: btoa(text),
      size: text.length,
    });
  }

  if (url.pathname === `/repos/octo/demo/git/blobs/${"c".repeat(40)}`)
    return jsonResponse({ encoding: "base64", content: btoa("{}"), size: 2 });

  return fullRoute(url);
}

describe("real MCP SDK integration", () => {
  it("exposes exactly eight read-only tools and enforces their input schemas", async () => {
    const { client, calls } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "action_plan",
      "branch_risk",
      "delivery_hygiene",
      "portfolio_snapshot",
      "repo_readiness",
      "security_posture",
      "settings_drift",
      "standards_audit",
    ]);

    for (const tool of tools)
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });

    const invalid = await client.callTool({
      name: "standards_audit",
      arguments: { owner: "../octo", repo: "demo" },
    });

    expect(invalid.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("preserves bounded portfolio coverage in the tool-visible result", async () => {
    const { client } = await connect((url) => {
      if (url.pathname === "/users/octo/repos") {
        return jsonResponse(
          Array.from({ length: 50 }, () => ({ ...repository, archived: true })),
          200,
          "https://api.github.com/users/octo/repos?page=2",
        );
      }

      return auditRoute(url);
    });

    const result = await client.callTool({
      name: "portfolio_snapshot",
      arguments: { owner: "octo" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      owner: "octo",
      status: "partial",
      availableRepositories: 50,
      scannedRepositories: 0,
      results: [],
      scope: {
        status: "truncated",
        listing: {
          nextUrl: "https://api.github.com/users/octo/repos?page=2",
          countKind: "lower_bound",
        },
      },
    });
  });

  it("returns the standards report through the SDK", async () => {
    const { client } = await connect();

    const result = await client.callTool({
      name: "standards_audit",
      arguments: { owner: "octo", repo: "demo" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      baseline: "shipshape/recommended@1",
      commit: "a".repeat(40),
      audit: {
        checks: expect.arrayContaining([
          expect.objectContaining({ ruleId: "standards.test", state: "fail" }),
        ]),
      },
    });
  });

  it("includes standards failures in action_plan and starts both collections concurrently", async () => {
    let releaseReadiness = () => {};

    const gate = new Promise<void>((resolve) => {
      releaseReadiness = resolve;
    });

    const { client, calls } = await connect(async (url) => {
      if (url.pathname === "/repos/octo/demo/branches/main") await gate;

      if (url.pathname === "/repos/octo/demo/commits/main") releaseReadiness();

      return auditRoute(url);
    });

    const result = await client.callTool({
      name: "action_plan",
      arguments: { owner: "octo", repo: "demo", limit: 20 },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      plan: {
        items: expect.arrayContaining([
          expect.objectContaining({ ruleId: "standards.test", state: "fail" }),
        ]),
      },
    });
    expect(
      calls.some((url) => url.pathname === "/repos/octo/demo/branches/main"),
    ).toBe(true);
    expect(
      calls.some((url) => url.pathname === "/repos/octo/demo/commits/main"),
    ).toBe(true);
  });

  it("inspects security posture without collecting readiness history", async () => {
    const { client, calls } = await connect();

    const result = await client.callTool({
      name: "security_posture",
      arguments: { owner: "octo", repo: "demo" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      repository: { owner: "octo", repo: "demo" },
    });
    expect(
      calls.some((url) =>
        /\/(commits|pulls|actions\/runs)$/.test(url.pathname),
      ),
    ).toBe(false);
    expect(calls.some((url) => url.pathname.endsWith("/branches/main"))).toBe(
      true,
    );
  });

  it("refuses private repositories before reading their contents", async () => {
    const { client, calls } = await connect(() =>
      jsonResponse({ ...repository, private: true }),
    );

    const result = await client.callTool({
      name: "standards_audit",
      arguments: { owner: "octo", repo: "demo" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "Shipshape only inspects public repositories." },
    ]);
    expect(calls.map((url) => url.pathname)).toEqual(["/repos/octo/demo"]);
  });

  it("reports settings drift with reviewable remediation and no writes", async () => {
    const { client, calls } = await connect((url) => {
      if (url.pathname === "/users/octo/repos")
        return jsonResponse([
          repository,
          { ...repository, name: "fork", full_name: "octo/fork", fork: true },
        ]);

      if (url.pathname === "/repos/octo/demo")
        return jsonResponse({
          ...repository,
          allow_squash_merge: false,
          delete_branch_on_merge: true,
        });

      if (url.pathname === "/repos/octo/demo/branches/main/protection")
        return jsonResponse({
          required_status_checks: null,
          enforce_admins: {
            url: "https://api.github.com/repos/octo/demo/branches/main/protection/enforce_admins",
            enabled: false,
          },
          required_signatures: {
            url: "https://api.github.com/repos/octo/demo/branches/main/protection/required_signatures",
            enabled: true,
          },
          required_linear_history: { enabled: true },
          allow_force_pushes: { enabled: false },
          allow_deletions: { enabled: false },
          required_conversation_resolution: { enabled: false },
        });

      return auditRoute(url);
    });

    const result = await client.callTool({
      name: "settings_drift",
      arguments: {
        owner: "octo",
        rules: {
          version: 1,
          rules: [
            {
              id: "baseline",
              merge: { allowSquash: true, deleteBranchOnMerge: true },
              branchProtection: {
                requiredSignatures: true,
                requiredLinearHistory: true,
                enforceAdmins: true,
              },
            },
          ],
        },
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      owner: "octo",
      status: "drifted",
      policy: { kind: "inline" },
      scope: { matchedRepositories: 1, scannedRepositories: 1 },
      totals: { drifted: 1, remediationSteps: 2 },
      repositories: [
        {
          repository: "octo/demo",
          counts: { pass: 3, fail: 2, unknown: 0 },
          remediation: [
            {
              method: "PATCH",
              path: "/repos/octo/demo",
              body: { allow_squash_merge: true },
            },
            {
              method: "PUT",
              path: "/repos/octo/demo/branches/main/protection",
              body: { enforce_admins: true, required_linear_history: true },
            },
          ],
        },
      ],
    });
    expect(calls.map((url) => url.pathname)).not.toContain("/repos/octo/fork");
  });

  it("loads a pinned policy file and requires exactly one policy source", async () => {
    const sha = "d".repeat(40);

    const text =
      "version: 1\nrules:\n  - id: topics\n    topics: {required: [demo]}\n";

    const { client } = await connect((url) => {
      if (url.pathname === "/users/octo/repos")
        return jsonResponse([repository]);

      if (url.pathname === "/repos/octo/standards")
        return jsonResponse({ ...repository, name: "standards" });

      if (url.pathname === `/repos/octo/standards/git/trees/${sha}`)
        return jsonResponse({
          truncated: false,
          tree: [
            {
              path: "repo-rules.yml",
              sha: "e".repeat(40),
              mode: "100644",
              type: "blob",
              size: text.length,
            },
          ],
        });

      if (url.pathname === `/repos/octo/standards/git/blobs/${"e".repeat(40)}`)
        return jsonResponse({
          encoding: "base64",
          content: btoa(text),
          size: text.length,
        });

      return auditRoute(url);
    });

    const result = await client.callTool({
      name: "settings_drift",
      arguments: {
        owner: "octo",
        policy: {
          owner: "octo",
          repo: "standards",
          ref: sha,
          path: "repo-rules.yml",
        },
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "compliant",
      policy: {
        kind: "policy",
        url: `https://github.com/octo/standards/blob/${sha}/repo-rules.yml`,
      },
      repositories: [
        { repository: "octo/demo", status: "compliant", remediation: [] },
      ],
    });

    const neither = await client.callTool({
      name: "settings_drift",
      arguments: { owner: "octo" },
    });

    expect(neither.isError).toBe(true);
    expect(neither.content).toEqual([
      { type: "text", text: "Provide exactly one of rules or policy." },
    ]);
  });
});
