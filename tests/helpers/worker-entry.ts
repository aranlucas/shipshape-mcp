import provider from "../../src/index";

// Miniflare's local HTTP/RPC bridges rewrite Host to their loopback listener.
// Reproduce the edge request authority before entering the unchanged production
// provider. A dedicated test header permits checking the Host rejection path.
export default {
  fetch(request, env, ctx) {
    const headers = new Headers(request.headers);
    headers.set(
      "Host",
      headers.get("X-Fixture-Host") ?? new URL(request.url).host,
    );
    headers.delete("X-Fixture-Host");

    return provider.fetch(new Request(request, { headers }), env, ctx);
  },
} satisfies ExportedHandler<Parameters<typeof provider.fetch>[1]>;
