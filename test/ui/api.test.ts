import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/ui/api";

// The Worker refuses non-GET API requests without a JSON content type.
describe("dashboard API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["savePractice", () => api.savePractice("lint", { yaml: "id: lint\n" })],
    ["deletePractice", () => api.deletePractice("lint")],
    ["resetPractice", () => api.resetPractice("lint")],
    ["refresh", () => api.refresh()],
  ])("sends %s as JSON", async (_name, call) => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('{"catalogSha":"abc","queued":0}', { status: 200 })),
    );

    vi.stubGlobal("fetch", fetchMock);

    await call();

    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    expect(init?.body).toBeTypeOf("string");
  });
});
