import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";

import { MCP_RESOURCE, MCP_SCOPE, PUBLIC_ORIGIN } from "./config";
import { createShipshapeServer } from "./mcp";
import defaultHandler, { type OAuthEnv } from "./oauth";

const apiHandler = createMcpHandler(createShipshapeServer, {
  route: "/mcp",
  legacy: "stateless",
});

const protectedHandler = {
  fetch(request, env, ctx) {
    return apiHandler(request, env, ctx);
  },
} satisfies { fetch: ExportedHandlerFetchHandler<OAuthEnv> };

export default new OAuthProvider<OAuthEnv>({
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
