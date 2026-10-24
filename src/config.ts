const portlessOrigin = process.env.PORTLESS_URL;

const PUBLIC_ORIGIN =
  portlessOrigin !== undefined && portlessOrigin.length > 0
    ? portlessOrigin
    : "https://shipshape-mcp.aranlucas.workers.dev";

export const MCP_RESOURCE = `${PUBLIC_ORIGIN}/mcp` as const;

export const MCP_SCOPE = "shipshape:access" as const;

/** REST API version sent on every GitHub request. */
export const GITHUB_API_VERSION = "2026-03-10" as const;
