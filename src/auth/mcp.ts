import { createMcpProtectedRequestHandler } from "@better-auth/mcp";
import { metadataResponse } from "@better-auth/oauth-provider";
import { hostHeaderValidationResponse } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { parseAccessTokenAuthorization } from "better-auth/oauth2";
import { z } from "zod";

import { MCP_SCOPE } from "../config";
import type { AppEnv } from "../env";
import { createPracticesServer } from "../mcp";
import { callbackUrl } from "../oauth";
import { requeueIfBuiltInsChanged } from "../queue";
import { accessTokenOptions, authSettings, accessIdentity } from "./better-auth";
import { isOwner } from "./owner";

const OriginSchema = z.url().refine((value) => new URL(value).origin === value);

function withCors(response: Response, origin: string, methods = "GET, HEAD, OPTIONS") {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", methods);
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Session-Id",
  );
  headers.set("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
  headers.set("Cache-Control", "no-store");
  headers.append("Vary", "Origin");

  return new Response(response.body, { status: response.status, headers });
}

export function resourceMetadata(request: Request, env: AppEnv) {
  if (request.method === "OPTIONS") {
    return withCors(new Response(null), "*");
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return withCors(
      new Response(null, { status: 405, headers: { Allow: "GET, HEAD, OPTIONS" } }),
      "*",
    );
  }

  const response = metadataResponse({
    resource: callbackUrl(request, env, "/mcp").href,
    authorization_servers: [authSettings(env).issuer],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Shipshape MCP",
  });

  return withCors(request.method === "HEAD" ? new Response(null, response) : response, "*");
}

export async function protectedMcp(request: Request, env: AppEnv, ctx: ExecutionContext) {
  const resource = callbackUrl(request, env, "/mcp").href;
  const resourceUrl = new URL(resource);

  const configuredOrigins = z
    .array(OriginSchema)
    .parse(JSON.parse(env.MCP_ALLOWED_ORIGINS ?? "[]"));

  const allowedOrigins = [...new Set([resourceUrl.origin, ...configuredOrigins])];
  const origin = request.headers.get("Origin");

  if (origin !== null && !allowedOrigins.includes(origin)) {
    return new Response("Origin not allowed", { status: 403 });
  }

  const hostRejection = hostHeaderValidationResponse(request, [resourceUrl.hostname]);

  if (hostRejection) {
    return hostRejection;
  }

  const corsOrigin = origin ?? resourceUrl.origin;
  const methods = "GET, POST, DELETE, OPTIONS";

  if (request.method === "OPTIONS") {
    return withCors(new Response(null), corsOrigin, methods);
  }

  const options = accessTokenOptions(env, resource);

  const handler = createMcpProtectedRequestHandler(
    {
      issuer: options.verifyOptions.issuer,
      audience: resource,
      jwksUrl: options.jwksUrl,
      jwtVerifyOptions: options.verifyOptions,
      requiredScopes: options.requiredScopes,
    },
    (verifiedRequest, claims) => {
      const identity = accessIdentity(claims);

      if (!identity || !isOwner(env, identity.identity)) {
        return new Response("Forbidden", { status: 403 });
      }

      const authorization = parseAccessTokenAuthorization(
        verifiedRequest.headers.get("Authorization"),
      );

      if (!authorization?.token) {
        return new Response("Unauthorized", { status: 401 });
      }

      ctx.waitUntil(requeueIfBuiltInsChanged(env));

      return createMcpHandler(() => createPracticesServer(env), {
        route: "/mcp",
        legacy: "stateless",
        authContext: { props: identity.identity },
        allowedHostnames: [resourceUrl.hostname],
        allowedOriginHostnames: allowedOrigins.map((allowed) => new URL(allowed).hostname),
      }).fetch(verifiedRequest, {
        authInfo: {
          token: authorization.token,
          clientId: identity.clientId,
          scopes: identity.scopes,
          expiresAt: identity.expiresAt,
          resource: resourceUrl,
        },
      });
    },
  );

  return withCors(await handler(request), corsOrigin, methods);
}
