export const PUBLIC_ORIGIN =
  "https://shipshape-mcp.aranlucas.workers.dev" as const;
export const MCP_RESOURCE = `${PUBLIC_ORIGIN}/mcp` as const;
export const MCP_SCOPE = "mcp:read" as const;
export const GITHUB_SCOPE = "read:user" as const;
/** REST API version sent on every GitHub request. */
export const GITHUB_API_VERSION = "2026-03-10" as const;
