import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";

import { z } from "zod";
import { GitHubOwnerInputSchema } from "./github/schemas";
import { createGitHubOctokit, GitHubInputError } from "./github/client";

import { MCP_RESOURCE, MCP_SCOPE, PUBLIC_ORIGIN } from "./config";
import { createPortfolioServer } from "./mcp";
import type { OAuthEnv } from "./oauth";
import { defaultHandler } from "./oauth-runtime";

const AuthPropsSchema = z.object({
  accessToken: z.string().min(1).max(4_096),
  login: GitHubOwnerInputSchema,
});

function githubClient() {
  const parsed = AuthPropsSchema.safeParse(getMcpAuthContext()?.props);

  if (!parsed.success)
    throw new GitHubInputError("GitHub authorization is required");

  return createGitHubOctokit(parsed.data.accessToken);
}

const apiHandler = createMcpHandler(() => createPortfolioServer(githubClient), {
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
