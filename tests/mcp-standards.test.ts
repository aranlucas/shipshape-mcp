import { describe, expect, it, vi } from "vitest";
import { makeCheck } from "../src/domain/rules";
const mocks = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (
      input: Record<string, unknown>,
    ) => Promise<{ structuredContent: Record<string, unknown> }>
  >(),
  standards: vi.fn(),
  readiness: vi.fn(),
}));
vi.mock("@modelcontextprotocol/server", () => ({
  McpServer: class {
    registerTool(name: string, _options: unknown, handler: never) {
      mocks.handlers.set(name, handler);
    }
  },
}));
vi.mock("agents/mcp/server", () => ({
  getMcpAuthContext: () => ({
    props: { accessToken: "test-token", login: "octo" },
  }),
}));
vi.mock("../src/standards/collect", () => ({
  collectStandards: mocks.standards,
}));
vi.mock("../src/github/collectors", () => ({
  collectRepositoryReadiness: mocks.readiness,
  collectBranchRisk: vi.fn(),
  collectDeliveryHygiene: vi.fn(),
  collectPortfolioSnapshot: vi.fn(),
}));
vi.mock("../src/domain/evaluate", () => ({
  evaluateRepositoryReadiness: () => [],
  evaluateBranchRisk: vi.fn(),
  evaluateDeliveryHygiene: vi.fn(),
  evaluateSecurityPosture: vi.fn(),
}));
import { createShipshapeServer } from "../src/mcp";
describe("standards MCP integration", () => {
  it("registers the read-only standards tool and returns its structured report", async () => {
    mocks.standards.mockResolvedValue({
      baseline: "shipshape/recommended@1",
      commit: "a".repeat(40),
      audit: { checks: [] },
    });
    createShipshapeServer();
    const result = await mocks.handlers.get("standards_audit")!({
      owner: "octo",
      repo: "demo",
    });
    expect(result.structuredContent.baseline).toBe("shipshape/recommended@1");
    expect(mocks.standards).toHaveBeenCalledWith(expect.anything(), {
      owner: "octo",
      repo: "demo",
    });
  });
  it("includes standards failures in the existing action plan", async () => {
    mocks.readiness.mockResolvedValue({
      repository: { fullName: "octo/demo" },
    });
    mocks.standards.mockResolvedValue({
      audit: {
        checks: [makeCheck({ ruleId: "standards.test", state: "fail" })],
      },
    });
    createShipshapeServer();
    const result = await mocks.handlers.get("action_plan")!({
      owner: "octo",
      repo: "demo",
      limit: 8,
    });
    expect(result.structuredContent.plan).toMatchObject({
      items: [{ ruleId: "standards.test", state: "fail" }],
    });
  });
});
