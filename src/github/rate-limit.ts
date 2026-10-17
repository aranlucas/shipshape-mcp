import { z } from "zod";

const errorSchema = z.object({
  status: z.number(),
  response: z
    .object({
      headers: z
        .record(z.string(), z.union([z.string(), z.number()]))
        .catch({})
        .optional(),
      data: z.object({ message: z.string().optional() }).catch({}).optional(),
    })
    .optional(),
});

/** A permission 403 must not be retried as if it were a quota response. */
// This parser is the boundary for errors thrown by GitHub fetch/Octokit.
export function rateLimitDelay(cause: unknown, now = Date.now()): number | undefined {
  const parsed = errorSchema.safeParse(cause);

  if (!parsed.success) {
    return undefined;
  }

  const { status, response } = parsed.data;
  const headers = response?.headers ?? {};
  const retryAfter = headers["retry-after"];

  const limited =
    status === 429 ||
    (status === 403 &&
      (String(headers["x-ratelimit-remaining"]) === "0" ||
        retryAfter !== undefined ||
        /(?:secondary )?rate limit/iu.test(response?.data?.message ?? "")));

  if (!limited) {
    return undefined;
  }

  const retrySeconds =
    retryAfter === undefined
      ? 0
      : /^\d+$/u.test(String(retryAfter))
        ? Number(retryAfter)
        : (Date.parse(String(retryAfter)) - now) / 1000;

  const resetSeconds = Number(headers["x-ratelimit-reset"] ?? 0) - now / 1000;

  return Math.ceil(
    Math.max(
      60,
      Number.isFinite(retrySeconds) ? retrySeconds : 0,
      Number.isFinite(resetSeconds) ? resetSeconds : 0,
    ),
  );
}
