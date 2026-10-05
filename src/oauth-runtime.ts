import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import { createOAuthHandler, type OAuthEnv } from "./oauth";
import { securityHeaders } from "./oauth-security";
import { isWebPath, webHandler } from "./web/routes";

const oauthHandler = createOAuthHandler({
  authorizationError(cause) {
    return cause instanceof AuthorizationError ? cause : null;
  },
});

/** The website companion shares the Worker but not the MCP authorization flow. */
export const defaultHandler: ExportedHandler<OAuthEnv> = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!isWebPath(url.pathname, url.searchParams.get("state")))
      return oauthHandler.defaultHandler.fetch(request, env);

    try {
      return await webHandler(request, env);
    } catch {
      return new Response("Service unavailable", {
        status: 500,
        headers: securityHeaders(),
      });
    }
  },
};
