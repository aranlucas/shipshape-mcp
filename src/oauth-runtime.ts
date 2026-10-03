import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import { createOAuthHandler } from "./oauth";

export const { defaultHandler } = createOAuthHandler({
  authorizationError(cause) {
    return cause instanceof AuthorizationError ? cause : null;
  },
});
