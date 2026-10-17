import { preact } from "@preact/preset-vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";
import { handleFixtureRequest } from "./src/ui/dev/fixture-api.ts";

const FIXTURE_LATENCY_MS = 250;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      resolve(body);
    });
    request.on("error", reject);
  });
}

function sendFixture(request: IncomingMessage, response: ServerResponse, body: string): void {
  const result = handleFixtureRequest(request.method ?? "GET", request.url ?? "/", body);

  setTimeout(() => {
    response.statusCode = result.status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(result.body));
  }, FIXTURE_LATENCY_MS);
}

/**
 * The dashboard is a static client bundle served by the Worker under /app.
 * `pnpm ui:dev` serves it alone with a fixture API so it can be built
 * without GitHub credentials; the fixtures follow src/api/contract.ts.
 */
function fixtureApi(): Plugin {
  return {
    name: "shipshape-fixture-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith("/app/api/")) {
          next();

          return;
        }

        readBody(request).then(
          (body) => {
            sendFixture(request, response, body);

            return body;
          },
          (cause: unknown) => {
            response.statusCode = 400;
            response.end(cause instanceof Error ? cause.message : "Unreadable request body");
          },
        );
      });
    },
  };
}

export default defineConfig({
  root: "src/ui",
  base: "/app/",
  plugins: [preact(), fixtureApi()],
  build: {
    // Copied into the Worker's static assets by the main Vite build (publicDir).
    outDir: "../../public/app",
    emptyOutDir: true,
  },
  server: { port: 5200, strictPort: true },
});
