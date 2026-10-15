import { describe, expect, it } from "vitest";
import { PrivateRepositoryError } from "@/github/client";
import { collectPullRequestReview } from "@/review/pull-requests";
import {
  clientFor,
  coordinates,
  jsonResponse,
  pullRequest,
  repository,
} from "@test/helpers/github-fixtures";

const headSha = "c".repeat(40);

const pr = { ...pullRequest, head: { sha: headSha } };

const check = {
  id: 21,
  name: "Verify",
  head_sha: headSha,
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/octo/demo/runs/21",
  details_url: null,
  output: null,
  app: null,
};

const actionCheck = {
  ...check,
  conclusion: "failure",
  html_url: "https://github.com/octo/demo/actions/runs/7/job/81",
  app: { slug: "github-actions" },
};

const status = {
  context: "Deploy",
  state: "success",
  description: "Deployment ready",
  target_url: "https://vercel.com/octo/demo/123",
  creator: { login: "vercel[bot]" },
};

const job = {
  id: 81,
  head_sha: headSha,
  status: "completed",
  conclusion: "failure",
  runner_id: 12,
  runner_name: "Hosted runner",
  steps: [
    {
      name: "Run unit tests",
      status: "completed",
      conclusion: "failure",
      started_at: "2026-10-15T00:00:00Z",
      completed_at: "2026-10-15T00:01:00Z",
    },
  ],
};

function setup(override?: (url: URL) => Response | undefined) {
  const methods: (string | undefined)[] = [];

  const mocked = clientFor((url, init) => {
    methods.push(init?.method);
    const response = override?.(url);

    if (response) {
      return response;
    }

    const path = url.pathname;

    if (path === "/repos/octo/demo") {
      return jsonResponse(repository);
    }

    if (path === "/repos/octo/demo/pulls") {
      return jsonResponse([pr]);
    }

    if (path === `/repos/octo/demo/commits/${headSha}/check-runs`) {
      return jsonResponse({ total_count: 1, check_runs: [check] });
    }

    if (path === `/repos/octo/demo/commits/${headSha}/status`) {
      return jsonResponse({ sha: headSha, total_count: 0, statuses: [] });
    }

    if (path === "/repos/octo/demo/actions/jobs/81") {
      return jsonResponse(job);
    }

    throw new Error(`Unhandled test route: ${url}`);
  });

  return { ...mocked, methods };
}

describe("read-only pull request review", () => {
  it("pins checks to the observed head SHA and keeps metadata and approval-safe next steps", async () => {
    const { client, calls, methods } = setup();
    const result = await collectPullRequestReview(client, coordinates);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      id: "pull_requests.1",
      title: "#1: Improve docs",
      state: "observed",
      approvalRequired: true,
    });
    expect(result.findings[0]?.current).toContain(`Head SHA: ${headSha}`);
    expect(result.findings[0]?.current).toContain("Draft: yes");
    expect(result.findings[0]?.current).toContain(pr.updated_at);
    expect(result.findings[0]?.current).toContain("merge readiness is not established");
    expect(result.findings[0]?.nextStep).toContain("Obtain approval");
    expect(result.findings[0]?.evidence[0]).toMatchObject({
      url: pr.html_url,
    });
    expect(result.findings[0]?.evidence[0]?.detail).toContain(headSha);
    expect(calls.filter((url) => url.pathname.includes("/commits/"))).toHaveLength(2);
    expect(
      calls
        .filter((url) => url.pathname.includes("/commits/"))
        .every((url) => url.pathname.includes(headSha)),
    ).toBe(true);
    expect(
      calls
        .filter((url) => url.pathname.includes("/commits/"))
        .every((url) => url.searchParams.get("per_page") === "30"),
    ).toBe(true);
    expect(calls.some((url) => url.pathname.includes("/logs"))).toBe(false);
    expect(methods.every((method) => method === "GET")).toBe(true);
    expect(result.limitations.join(" ")).toContain(
      "review approvals and mergeability are not inspected",
    );
  });

  it("does not diagnose code or runner failures from a failed conclusion alone", async () => {
    const { client, calls } = setup((url) =>
      url.pathname.endsWith("/check-runs")
        ? jsonResponse({ total_count: 1, check_runs: [{ ...check, conclusion: "failure" }] })
        : undefined,
    );

    const result = await collectPullRequestReview(client, coordinates);
    expect(result.findings[0]?.state).toBe("needs_review");
    expect(result.findings[0]?.current).toContain("Checks failed; cause unknown");
    expect(result.findings[0]?.current).not.toContain("Check execution failed");
    expect(result.findings[0]?.current).not.toContain("Runner unavailability reported");
    expect(calls).toHaveLength(4);
  });

  it("reports a failed executed step only with matching actual job and assigned runner evidence", async () => {
    const { client, calls } = setup((url) =>
      url.pathname.endsWith("/check-runs")
        ? jsonResponse({ total_count: 1, check_runs: [actionCheck] })
        : undefined,
    );

    const result = await collectPullRequestReview(client, coordinates);
    expect(result.findings[0]?.current).toContain(
      "Check execution failed in step “Run unit tests” on assigned job 81",
    );
    expect(result.findings[0]?.current).toContain(
      "Code versus environment root cause remains unverified",
    );
    expect(result.findings[0]?.state).toBe("needs_review");
    expect(result.findings[0]?.evidence).toContainEqual(
      expect.objectContaining({ url: actionCheck.html_url }),
    );
    expect(calls.filter((url) => url.pathname.includes("/actions/jobs/"))).toHaveLength(1);
  });

  it("keeps queued and unassigned work unknown without diagnosing runner unavailability", async () => {
    const { client } = setup((url) => {
      if (url.pathname.endsWith("/check-runs")) {
        return jsonResponse({
          total_count: 1,
          check_runs: [{ ...actionCheck, status: "queued", conclusion: null }],
        });
      }

      if (url.pathname.endsWith("/jobs/81")) {
        return jsonResponse({
          ...job,
          status: "queued",
          conclusion: null,
          runner_id: 0,
          runner_name: "",
          steps: [],
        });
      }
    });

    const result = await collectPullRequestReview(client, coordinates);
    expect(result.findings[0]?.state).toBe("unknown");
    expect(result.findings[0]?.current).toContain(
      "Pending execution or completion; runner availability is unknown",
    );
    expect(result.findings[0]?.current).not.toContain("Runner unavailability reported");
    expect(result.findings[0]?.current).not.toContain("observations passed");
  });

  it("requires explicit runner diagnostics and actual assigned job evidence for runner unavailability", async () => {
    const { client } = setup((url) =>
      url.pathname.endsWith("/check-runs")
        ? jsonResponse({
            total_count: 1,
            check_runs: [
              {
                ...actionCheck,
                output: { summary: "The runner lost communication with the server." },
              },
            ],
          })
        : undefined,
    );

    const result = await collectPullRequestReview(client, coordinates);
    expect(result.findings[0]?.current).toContain(
      "Runner unavailability reported for assigned job 81",
    );
    expect(result.findings[0]?.current).not.toContain("Check execution failed");
  });

  it("does not use setup failures as proof of code execution failure", async () => {
    const { client } = setup((url) => {
      if (url.pathname.endsWith("/check-runs")) {
        return jsonResponse({ total_count: 1, check_runs: [actionCheck] });
      }

      if (url.pathname.endsWith("/jobs/81")) {
        return jsonResponse({ ...job, steps: [{ ...job.steps[0], name: "Set up job" }] });
      }
    });

    const result = await collectPullRequestReview(client, coordinates);
    expect(result.findings[0]?.current).toContain("Checks failed; cause unknown");
    expect(result.findings[0]?.current).not.toContain("Check execution failed");
  });

  it("surfaces explicit provider quota output from a recognized check provider", async () => {
    const { client } = setup((url) =>
      url.pathname.endsWith("/check-runs")
        ? jsonResponse({
            total_count: 1,
            check_runs: [
              {
                ...check,
                conclusion: "failure",
                app: { slug: "vercel" },
                output: {
                  summary:
                    "Resource is limited - try again in 1 hour (code: api-deployments-free-per-day).",
                },
              },
            ],
          })
        : undefined,
    );

    const result = await collectPullRequestReview(client, coordinates);
    expect(result.findings[0]?.current).toContain("Provider limit reported by Vercel");
    expect(result.findings[0]?.current).not.toContain("Check execution failed");
    expect(result.findings[0]?.evidence[1]?.detail).toContain("api-deployments-free-per-day");
  });

  it("reads generic status contexts and attributes explicit provider limits to matching provider identity", async () => {
    const { client } = setup((url) =>
      url.pathname.endsWith("/status")
        ? jsonResponse({
            sha: headSha,
            total_count: 1,
            statuses: [{ ...status, state: "error", description: "Deployment quota exceeded" }],
          })
        : undefined,
    );

    const result = await collectPullRequestReview(client, coordinates);
    expect(result.findings[0]?.state).toBe("needs_review");
    expect(result.findings[0]?.current).toContain(
      "Deploy: error. Provider limit reported by Vercel",
    );
    expect(result.findings[0]?.evidence.at(-1)?.detail).toContain("Deployment quota exceeded");
    expect(result.findings[0]?.evidence).toContainEqual(
      expect.objectContaining({
        url: status.target_url,
      }),
    );
  });

  it("does not diagnose a provider limit from a context name or untrusted status actor", async () => {
    const { client } = setup((url) =>
      url.pathname.endsWith("/status")
        ? jsonResponse({
            sha: headSha,
            total_count: 1,
            statuses: [
              {
                ...status,
                context: "Vercel",
                state: "failure",
                description: "Deployment quota exceeded",
                creator: { login: "untrusted-person" },
              },
            ],
          })
        : undefined,
    );

    const result = await collectPullRequestReview(client, coordinates);
    expect(result.findings[0]?.current).toContain("Checks failed; cause unknown");
    expect(result.findings[0]?.current).not.toContain("Provider limit reported");
  });

  it("does not treat absent check and status evidence as success", async () => {
    const { client } = setup((url) =>
      url.pathname.endsWith("/check-runs")
        ? jsonResponse({ total_count: 0, check_runs: [] })
        : undefined,
    );

    const result = await collectPullRequestReview(client, coordinates);
    expect(result.findings[0]?.state).toBe("unknown");
    expect(result.findings[0]?.current).toContain("missing checks are not success");
  });

  it("preserves partial passes and unknown coverage when a status endpoint is unavailable, without retrying", async () => {
    const { client, calls } = setup((url) =>
      url.pathname.endsWith("/status")
        ? jsonResponse({ message: "Service unavailable" }, 503)
        : undefined,
    );

    const result = await collectPullRequestReview(client, coordinates);
    expect(result.findings[0]?.state).toBe("unknown");
    expect(result.findings[0]?.current).toContain("Verify: completed / success");
    expect(result.findings[0]?.current).toContain("Evidence collection is incomplete");
    expect(result.limitations.join(" ")).toContain("Commit status evidence is unavailable");
    expect(calls.filter((url) => url.pathname.endsWith("/status"))).toHaveLength(1);
  });

  it("preserves unknown when checks are inaccessible even if a status passed", async () => {
    const { client } = setup((url) => {
      if (url.pathname.endsWith("/check-runs")) {
        return jsonResponse({ message: "Forbidden" }, 403);
      }

      if (url.pathname.endsWith("/status")) {
        return jsonResponse({ sha: headSha, total_count: 1, statuses: [status] });
      }
    });

    const result = await collectPullRequestReview(client, coordinates);
    expect(result.findings[0]?.state).toBe("unknown");
    expect(result.findings[0]?.current).toContain("Deploy: success");
    expect(result.limitations.join(" ")).toContain("Check-run evidence is unavailable");
  });

  it("does not fetch further check pages or turn a truncated set of passes into success", async () => {
    const { client, calls } = setup((url) =>
      url.pathname.endsWith("/check-runs")
        ? jsonResponse(
            {
              total_count: 31,
              check_runs: Array.from({ length: 30 }, (_, index) => ({ ...check, id: index + 1 })),
            },
            200,
            `https://api.github.com/repos/octo/demo/commits/${headSha}/check-runs?page=2`,
          )
        : undefined,
    );

    const result = await collectPullRequestReview(client, coordinates);
    expect(result.findings[0]?.state).toBe("unknown");
    expect(result.limitations.join(" ")).toContain("Check-run collection is incomplete");
    expect(result.findings[0]?.evidence).toHaveLength(31);
    expect(calls.filter((url) => url.pathname.endsWith("/check-runs"))).toHaveLength(1);
  });

  it("does not fetch further status pages or treat a partial status collection as complete", async () => {
    const { client, calls } = setup((url) =>
      url.pathname.endsWith("/status")
        ? jsonResponse({ sha: headSha, total_count: 31, statuses: [status] })
        : undefined,
    );

    const result = await collectPullRequestReview(client, coordinates);
    expect(result.findings[0]?.state).toBe("unknown");
    expect(result.limitations.join(" ")).toContain("Commit status collection is incomplete");
    expect(calls.filter((url) => url.pathname.endsWith("/status"))).toHaveLength(1);
  });

  it("excludes check, status and job evidence belonging to another head SHA", async () => {
    const { client } = setup((url) => {
      if (url.pathname.endsWith("/check-runs")) {
        return jsonResponse({
          total_count: 1,
          check_runs: [{ ...check, head_sha: "d".repeat(40) }],
        });
      }

      if (url.pathname.endsWith("/status")) {
        return jsonResponse({ sha: "d".repeat(40), total_count: 1, statuses: [status] });
      }
    });

    const result = await collectPullRequestReview(client, coordinates);
    expect(result.findings[0]?.state).toBe("unknown");
    expect(result.findings[0]?.evidence).toHaveLength(1);
    expect(result.limitations.join(" ")).toContain("different head SHA");
  });

  it("does not use a mismatched job as proof of execution", async () => {
    const { client } = setup((url) => {
      if (url.pathname.endsWith("/check-runs")) {
        return jsonResponse({ total_count: 1, check_runs: [actionCheck] });
      }

      if (url.pathname.endsWith("/jobs/81")) {
        return jsonResponse({ ...job, head_sha: "e".repeat(40) });
      }
    });

    const result = await collectPullRequestReview(client, coordinates);
    expect(result.findings[0]?.state).toBe("needs_review");
    expect(result.findings[0]?.current).not.toContain("Check execution failed");
    expect(result.limitations.join(" ")).toContain("does not match the observed head SHA");
  });

  it("requires a valid observed head SHA before requesting any checks", async () => {
    const { client, calls } = setup((url) =>
      url.pathname.endsWith("/pulls") ? jsonResponse([pullRequest]) : undefined,
    );

    const result = await collectPullRequestReview(client, coordinates);
    expect(result.findings[0]?.state).toBe("unknown");
    expect(result.findings[0]?.current).toContain("Head SHA is unavailable or invalid");
    expect(calls).toHaveLength(2);
  });

  it.each([
    { private: true, visibility: "private" },
    { private: false, visibility: "private" },
    { private: false, visibility: "internal" },
  ])("rejects nonpublic metadata before any PR or check reads: %j", async (visibility) => {
    const { client, calls } = setup((url) =>
      url.pathname === "/repos/octo/demo"
        ? jsonResponse({ ...repository, ...visibility })
        : undefined,
    );

    await expect(collectPullRequestReview(client, coordinates)).rejects.toThrow(
      PrivateRepositoryError,
    );
    expect(calls).toHaveLength(1);
  });

  it("caps PR inspection at five and explicitly preserves the uninspected remainder", async () => {
    const { client, calls } = setup((url) =>
      url.pathname.endsWith("/pulls")
        ? jsonResponse(
            Array.from({ length: 6 }, (_, index) => ({ ...pr, number: index + 1 })),
            200,
            "https://api.github.com/repos/octo/demo/pulls?page=2",
          )
        : undefined,
    );

    const result = await collectPullRequestReview(client, coordinates);
    expect(result.findings.filter((item) => item.state === "observed")).toHaveLength(5);
    expect(result.findings.at(-1)).toMatchObject({
      id: "pull_requests.truncated",
      state: "unknown",
    });
    expect(result.limitations.join(" ")).toContain("additional open PRs were not inspected");
    expect(calls).toHaveLength(12);
    expect(calls.find((url) => url.pathname.endsWith("/pulls"))?.searchParams.get("per_page")).toBe(
      "5",
    );
  });

  it.each(["cancelled", "skipped", "neutral", "stale"])(
    "does not count %s as passing",
    async (conclusion) => {
      const { client } = setup((url) =>
        url.pathname.endsWith("/check-runs")
          ? jsonResponse({ total_count: 1, check_runs: [{ ...check, conclusion }] })
          : undefined,
      );

      const result = await collectPullRequestReview(client, coordinates);
      expect(result.findings[0]?.state).toBe("unknown");
      expect(result.findings[0]?.current).toContain("This is not a passing check");
    },
  );

  it("distinguishes an observed empty listing from an unavailable listing", async () => {
    const empty = setup((url) => (url.pathname.endsWith("/pulls") ? jsonResponse([]) : undefined));
    const emptyResult = await collectPullRequestReview(empty.client, coordinates);
    expect(emptyResult.findings[0]).toMatchObject({ id: "pull_requests.none", state: "observed" });
    expect(empty.calls).toHaveLength(2);

    const unavailable = setup((url) =>
      url.pathname.endsWith("/pulls") ? jsonResponse({ message: "Missing" }, 404) : undefined,
    );

    const unavailableResult = await collectPullRequestReview(unavailable.client, coordinates);
    expect(unavailableResult.findings[0]).toMatchObject({
      id: "pull_requests.unavailable",
      state: "unknown",
    });
    expect(unavailable.calls).toHaveLength(2);
  });

  it("rejects non-HTTPS check links and does not request arbitrary job URLs", async () => {
    const { client, calls } = setup((url) =>
      url.pathname.endsWith("/check-runs")
        ? jsonResponse({
            total_count: 1,
            check_runs: [
              {
                ...actionCheck,
                html_url: "javascript:alert(1)",
                details_url: "http://unsafe.example/job/81",
              },
            ],
          })
        : undefined,
    );

    const result = await collectPullRequestReview(client, coordinates);
    expect(result.findings[0]?.evidence[1]?.url).toBe(`${pr.html_url}/checks`);
    expect(calls).toHaveLength(4);
  });

  it("does not attribute execution or runner failure to a job with no assigned runner", async () => {
    const { client } = setup((url) => {
      if (url.pathname.endsWith("/check-runs")) {
        return jsonResponse({
          total_count: 1,
          check_runs: [
            {
              ...actionCheck,
              output: { summary: "The runner lost communication with the server." },
            },
          ],
        });
      }

      if (url.pathname.endsWith("/jobs/81")) {
        return jsonResponse({ ...job, runner_id: 0, runner_name: "" });
      }
    });

    const result = await collectPullRequestReview(client, coordinates);
    expect(result.findings[0]?.current).toContain("Checks failed; cause unknown");
    expect(result.findings[0]?.current).not.toContain("Runner unavailability reported");
    expect(result.findings[0]?.current).not.toContain("Check execution failed");
  });

  it("does not attribute arbitrary check output to a deployment provider", async () => {
    const { client } = setup((url) =>
      url.pathname.endsWith("/check-runs")
        ? jsonResponse({
            total_count: 1,
            check_runs: [
              {
                ...check,
                conclusion: "failure",
                app: { slug: "my-ci-tests" },
                output: { summary: "Deployment quota exceeded" },
              },
            ],
          })
        : undefined,
    );

    const result = await collectPullRequestReview(client, coordinates);
    expect(result.findings[0]?.current).toContain("Checks failed; cause unknown");
    expect(result.findings[0]?.current).not.toContain("Provider limit reported");
  });

  it("keeps unavailable job details unknown without replacing failed checks with passing evidence", async () => {
    const { client, calls } = setup((url) => {
      if (url.pathname.endsWith("/check-runs")) {
        return jsonResponse({ total_count: 1, check_runs: [actionCheck] });
      }

      if (url.pathname.endsWith("/jobs/81")) {
        return jsonResponse({ message: "Missing" }, 404);
      }
    });

    const result = await collectPullRequestReview(client, coordinates);
    expect(result.findings[0]?.state).toBe("needs_review");
    expect(result.findings[0]?.current).toContain("Checks failed; cause unknown");
    expect(result.limitations.join(" ")).toContain("Job 81 evidence is unavailable");
    expect(calls.filter((url) => url.pathname.endsWith("/jobs/81"))).toHaveLength(1);
  });

  it("bounds worst-case review to 37 GETs and two simultaneous reads while preserving job truncation", async () => {
    const { client, calls, methods } = setup((url) => {
      if (url.pathname.endsWith("/pulls")) {
        return jsonResponse(
          Array.from({ length: 5 }, (_, index) => ({ ...pr, number: index + 1 })),
        );
      }

      if (url.pathname.endsWith("/check-runs")) {
        return jsonResponse({
          total_count: 6,
          check_runs: Array.from({ length: 6 }, (_, index) => ({
            ...actionCheck,
            id: index + 1,
            html_url: `https://github.com/octo/demo/actions/runs/7/job/${index + 81}`,
          })),
        });
      }

      if (url.pathname.includes("/actions/jobs/")) {
        return jsonResponse({ ...job, id: Number(url.pathname.split("/").at(-1)) });
      }
    });

    let active = 0;
    let maximum = 0;
    client.hook.wrap("request", async (request, options) => {
      active += 1;
      maximum = Math.max(maximum, active);

      try {
        return await request(options);
      } finally {
        active -= 1;
      }
    });
    const result = await collectPullRequestReview(client, coordinates);
    expect(calls).toHaveLength(37);
    expect(maximum).toBeLessThanOrEqual(2);
    expect(result.findings).toHaveLength(5);
    expect(result.findings.every((finding) => finding.state === "needs_review")).toBe(true);
    expect(result.limitations.join(" ")).toContain("Job-detail inspection is capped at five jobs");
    expect(result.limitations.join(" ")).toContain("at most 37 GETs total");
    expect(calls.filter((url) => url.pathname.includes("/actions/jobs/"))).toHaveLength(25);
    expect(calls.some((url) => url.pathname.endsWith("/jobs/86"))).toBe(false);
    expect(methods.every((method) => method === "GET")).toBe(true);
  });

  it.each(["check-runs", "status"])(
    "keeps an observed %s failure visible when other evidence is unavailable",
    async (endpoint) => {
      const { client } = setup((url) => {
        if (url.pathname.endsWith("/check-runs")) {
          return endpoint === "check-runs"
            ? jsonResponse({ total_count: 1, check_runs: [{ ...check, conclusion: "failure" }] })
            : jsonResponse({ message: "Forbidden" }, 403);
        }

        if (url.pathname.endsWith("/status")) {
          return endpoint === "status"
            ? jsonResponse({
                sha: headSha,
                total_count: 1,
                statuses: [{ ...status, state: "failure" }],
              })
            : jsonResponse({ message: "Forbidden" }, 403);
        }
      });

      const result = await collectPullRequestReview(client, coordinates);
      expect(result.findings[0]?.state).toBe("needs_review");
      expect(result.findings[0]?.current).toContain("Checks failed; cause unknown");
      expect(result.findings[0]?.current).toContain("overall check coverage remains unknown");
      expect(result.limitations.join(" ")).toContain("unavailable");
    },
  );
});
