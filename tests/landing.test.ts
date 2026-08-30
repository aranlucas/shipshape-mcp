import {
  healthResponse,
  landingHandler,
  privacyPageResponse,
} from "../src/landing";
import { describe, expect, it } from "vitest";

describe("public landing handlers", () => {
  it("serves a static landing page with a script-free CSP", async () => {
    const response = landingHandler(new Request("https://shipshape.example/"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "script-src 'none'",
    );
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "style-src 'self'",
    );
    expect(body).not.toContain("<script");
    expect(body).toContain("Know what to fix next");
  });

  it("serves the same-origin stylesheet with an explicit content type", async () => {
    const response = landingHandler(
      new Request("https://shipshape.example/assets/shipshape.css"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/css");
    expect(response.headers.get("Cache-Control")).toContain("max-age=86400");
    expect(await response.text()).toContain("--ocean");
  });

  it("serves health and privacy endpoints", async () => {
    const health = healthResponse();
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const privacy = privacyPageResponse();
    expect(privacy.status).toBe(200);
    expect(await privacy.text()).toContain("Privacy");
    expect(privacy.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("returns a hardened 404 and rejects non-GET landing requests", async () => {
    const missing = landingHandler(
      new Request("https://shipshape.example/nope"),
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Content-Security-Policy")).toContain(
      "default-src 'none'",
    );

    const post = landingHandler(
      new Request("https://shipshape.example/", { method: "POST" }),
    );
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET");
  });
});
