import { describe, expect, it } from "vitest";
import { rateLimitDelay } from "@/github/rate-limit";

describe("GitHub retry timing", () => {
  it("preserves permission errors as permanent failures", () => {
    expect(
      rateLimitDelay({
        status: 403,
        response: { data: { message: "Resource not accessible by integration" } },
      }),
    ).toBeUndefined();
    expect(rateLimitDelay({ status: 404 })).toBeUndefined();
  });

  it("honors the longer reset and retry-after interval", () => {
    expect(
      rateLimitDelay(
        {
          status: 403,
          response: {
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "1600",
              "retry-after": "120",
            },
          },
        },
        1_000_000,
      ),
    ).toBe(600);
  });

  it("backs off secondary limits and 429 responses without a reset header", () => {
    expect(rateLimitDelay({ status: 429 })).toBe(60);
    expect(rateLimitDelay({ status: 429, response: { data: "Rate limited" } })).toBe(60);
    expect(
      rateLimitDelay({
        status: 403,
        response: { data: { message: "You have exceeded a secondary rate limit" } },
      }),
    ).toBe(60);
  });

  it("accepts HTTP-date retry-after values", () => {
    expect(
      rateLimitDelay(
        { status: 429, response: { headers: { "retry-after": "Thu, 01 Jan 1970 00:03:00 GMT" } } },
        0,
      ),
    ).toBe(180);
  });
});
