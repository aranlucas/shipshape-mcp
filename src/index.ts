import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";

import { GitHubInputError } from "./github/client";

import { MCP_RESOURCE, MCP_SCOPE, PUBLIC_ORIGIN } from "./config";
import { createPortfolioServer } from "./mcp";
import type { OAuthEnv } from "./oauth";
import { defaultHandler } from "./oauth-runtime";

const apiHandler = createMcpHandler(
  () =>
    createPortfolioServer(() => {
      throw new GitHubInputError("Re-implemented in Task 11");
    }),
  {
    route: "/mcp",
    legacy: "stateless",
  },
);

const protectedHandler = {
  fetch(request, env, ctx) {
    return apiHandler(request, env, ctx);
  },
} satisfies ProtectedHandler;

const provider = new OAuthProvider<OAuthEnv>({
  apiRoute: "/mcp",
  apiHandler: protectedHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  // Preserve native MCP clients such as Claude alongside HTTPS and loopback callbacks.
  allowPrivateUseRedirectUris: true,
  scopesSupported: [MCP_SCOPE],
  requiredScopes: [MCP_SCOPE],
  resourceMetadata: {
    resource: MCP_RESOURCE,
    authorization_servers: [PUBLIC_ORIGIN],
    bearer_methods_supported: ["header"],
    resource_name: "Shipshape MCP",
  },
  clientIdMetadataDocumentEnabled: true,
});

type ProtectedHandler = { fetch: ExportedHandlerFetchHandler<OAuthEnv> };

export default provider;
