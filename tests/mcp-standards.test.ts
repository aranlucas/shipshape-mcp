import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCheck } from "../src/domain/rules";
import { GITHUB_API_VERSION } from "../src/config";
const mocks = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (
      input: Record<string, unknown>,
    ) => Promise<{ structuredContent: Record<string, unknown> }>
  >(),
  standards: vi.fn(),
  readiness: vi.fn(),
  publicRepository: vi.fn(),
  branchRisk: vi.fn(),
  security: vi.fn(),
  octokitOptions: { latest: undefined as unknown },
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
vi.mock("octokit", () => ({
  Octokit: class {
    constructor(options: unknown) {
      mocks.octokitOptions.latest = options;
    }
  },
}));
vi.mock("../src/standards/collect", () => ({
  collectStandards: mocks.standards,
}));
vi.mock("../src/github/collectors", () => ({
  collectRepositoryReadiness: mocks.readiness,
  collectPublicRepository: mocks.publicRepository,
  collectBranchRisk: mocks.branchRisk,
  collectDeliveryHygiene: vi.fn(),
  collectPortfolioSnapshot: vi.fn(),
  collectSecurityPosture: mocks.security,
}));
vi.mock("../src/domain/evaluate", () => ({
  evaluateRepositoryReadiness: () => [],
  evaluateBranchRisk: vi.fn(),
  evaluateDeliveryHygiene: vi.fn(),
  evaluateSecurityPosture: () => [],
}));
import { createShipshapeServer } from "../src/mcp";
describe("standards MCP integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
    expect(GITHUB_API_VERSION).toBe("2026-03-10");
    expect(mocks.octokitOptions.latest).toMatchObject({
      request: {
        headers: { "X-GitHub-Api-Version": GITHUB_API_VERSION },
      },
    });
  });
  it("includes standards failures in the existing action plan", async () => {
    let releaseReadiness!: () => void;
    const readinessGate = new Promise<void>((resolve) => {
      releaseReadiness = resolve;
    });
    mocks.readiness.mockImplementation(async () => {
      await readinessGate;
      return { repository: { fullName: "octo/demo" } };
    });
    mocks.standards.mockImplementation(async () => {
      releaseReadiness();
      return {
        audit: {
          checks: [makeCheck({ ruleId: "standards.test", state: "fail" })],
        },
      };
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
  it("inspects security posture without repository readiness collection", async () => {
    mocks.publicRepository.mockResolvedValue({
      defaultBranch: "main",
      evidence: [],
      securitySettings: {},
    });
    mocks.branchRisk.mockResolvedValue({ status: "available", evidence: [] });
    mocks.security.mockResolvedValue({ evidence: [] });
    createShipshapeServer();
    const result = await mocks.handlers.get("security_posture")!({
      owner: "octo",
      repo: "demo",
    });
    expect(result.structuredContent).toMatchObject({
      repository: { owner: "octo", repo: "demo" },
    });
    expect(mocks.readiness).not.toHaveBeenCalled();
    expect(mocks.publicRepository).toHaveBeenCalledWith(
      expect.anything(),
      { owner: "octo", repo: "demo" },
      expect.objectContaining({ maxPages: 1 }),
    );
    expect(mocks.branchRisk).toHaveBeenCalledWith(
      expect.anything(),
      { owner: "octo", repo: "demo" },
      "main",
      expect.objectContaining({ maxPages: 1 }),
    );
    expect(mocks.security).toHaveBeenCalledWith(
      expect.anything(),
      { owner: "octo", repo: "demo" },
      expect.objectContaining({ maxPages: 1 }),
    );
  });
});
