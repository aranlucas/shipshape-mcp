import pLimit from "p-limit";
import { z, type ZodType } from "zod";
import type { Evidence } from "../domain/types";
import {
  parseGitHubResponse,
  PrivateRepositoryError,
  responseMetadata,
  type GitHubOctokit,
  type GitHubReadParameters,
} from "../github/client";
import {
  GitHubPullRequestSchema,
  GitHubRepositorySchema,
  RepositoryCoordinatesSchema,
  type GitHubPullRequest,
  type RepositoryCoordinates,
} from "../github/schemas";
import type { ReviewFinding } from "./types";

const PR_LIMIT = 5;

const CHECK_LIMIT = 30;

const JOB_LIMIT = 5;

const SHA = z.string().regex(/^[a-f\d]{40}$/iu);

const text = z.string().nullable().optional();

const CheckSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  head_sha: SHA,
  status: z.string(),
  conclusion: text,
  html_url: text,
  details_url: text,
  app: z.object({ slug: text }).nullable().optional(),
  output: z.object({ title: text, summary: text, text }).nullable().optional(),
});

const ChecksSchema = z.object({
  total_count: z.number().int().nonnegative(),
  check_runs: z.array(CheckSchema).max(100),
});

const StatusSchema = z.object({
  context: z.string(),
  state: z.string(),
  description: text,
  target_url: text,
  creator: z.object({ login: z.string() }).nullable().optional(),
});

const StatusesSchema = z.object({
  sha: SHA,
  total_count: z.number().int().nonnegative(),
  statuses: z.array(StatusSchema).max(100),
});

const JobSchema = z.object({
  id: z.number().int().positive(),
  head_sha: SHA,
  status: z.string(),
  conclusion: text,
  runner_id: z.number().int().nullable().optional(),
  runner_name: text,
  steps: z
    .array(
      z.object({
        name: z.string(),
        status: z.string(),
        conclusion: text,
        started_at: text,
        completed_at: text,
      }),
    )
    .max(200)
    .optional(),
});

type Check = z.infer<typeof CheckSchema>;

type Status = z.infer<typeof StatusSchema>;

type Job = z.infer<typeof JobSchema>;

type Read = ReturnType<typeof boundedReader>;

interface PullRequestReview {
  findings: ReviewFinding[];
  limitations: string[];
}

interface Observations {
  checks: Check[];
  statuses: Status[];
  jobs: Map<number, Job>;
  limitations: string[];
}

function boundedReader(client: GitHubOctokit) {
  const limit = pLimit(2);

  return <T>(route: `GET ${string}`, parameters: GitHubReadParameters, schema: ZodType<T>) =>
    limit(async () => {
      const response = await client.request(route, {
        ...parameters,
        // Callers also disable the Octokit throttling retry plugin at construction.
        request: { retries: 0, signal: AbortSignal.timeout(8_000) },
      });

      return { data: parseGitHubResponse(schema, response), metadata: responseMetadata(response) };
    });
}

function publicUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);

    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function outputText(check: Check): string {
  return [check.output?.title, check.output?.summary, check.output?.text]
    .filter((value) => value !== null && value !== undefined)
    .join("\n")
    .slice(0, 12_000);
}

function providerForCheck(check: Check): string | null {
  switch (check.app?.slug ?? "") {
    case "github-actions":
      return "GitHub Actions";
    case "vercel":
      return "Vercel";
    case "netlify":
      return "Netlify";
    case "cloudflare-pages":
      return "Cloudflare Pages";
    default:
      return null;
  }
}

function providerForStatus(status: Status): string | null {
  const target = publicUrl(status.target_url);

  if (!target) {
    return null;
  }

  const hostname = new URL(target).hostname;
  const login = status.creator?.login.toLowerCase();

  if ((login === "vercel" || login === "vercel[bot]") && hostname === "vercel.com") {
    return "Vercel";
  }

  if ((login === "netlify" || login === "netlify[bot]") && hostname === "app.netlify.com") {
    return "Netlify";
  }

  if (
    (login === "cloudflare-pages" || login === "cloudflare-pages[bot]") &&
    hostname === "dash.cloudflare.com"
  ) {
    return "Cloudflare Pages";
  }

  return null;
}

function reportsProviderLimit(value: string): boolean {
  return (
    /(?:^|\n)\s*resource is limited\b/iu.test(value) ||
    /(?:^|\n)\s*(?:you (?:have )?|your (?:account|team|project) has )(?:reached|exceeded) (?:the |your )?(?:(?:daily|monthly|build|deployment|usage|spending) )*(?:quota|limit)\b/iu.test(
      value,
    ) ||
    /(?:^|\n)\s*(?:(?:deployment|build|usage|spending|rate|api request) )+(?:quota|limit)(?: has been| is)? (?:exceeded|reached)\b/iu.test(
      value,
    ) ||
    /\bthe job was not started because recent account payments have failed or your spending limit needs to be increased\b/iu.test(
      value,
    )
  );
}

function actionJobId(check: Check, coordinates: RepositoryCoordinates): number | null {
  if (check.app?.slug !== "github-actions") {
    return null;
  }

  const value = publicUrl(check.html_url);

  if (!value) {
    return null;
  }

  const url = new URL(value);
  const prefix = `/${coordinates.owner}/${coordinates.repo}/`;

  if (
    url.hostname !== "github.com" ||
    !url.pathname.toLowerCase().startsWith(prefix.toLowerCase())
  ) {
    return null;
  }

  const match = /^(?:actions\/runs\/\d+\/job|runs\/\d+\/jobs)\/(\d+)$/u.exec(
    url.pathname.slice(prefix.length),
  );

  const id = Number(match?.[1]);

  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function failedCheck(check: Check): boolean {
  return (
    check.status === "completed" &&
    ["failure", "timed_out", "action_required", "startup_failure"].includes(check.conclusion ?? "")
  );
}

function assignedRunner(job: Job): boolean {
  return (job.runner_id ?? 0) > 0 && Boolean(job.runner_name?.trim());
}

function executedFailure(job: Job): string | null {
  if (!assignedRunner(job) || job.status !== "completed" || job.conclusion !== "failure") {
    return null;
  }

  const step = job.steps?.find(
    (item) =>
      item.status === "completed" &&
      item.conclusion === "failure" &&
      item.started_at &&
      item.completed_at &&
      Number.isFinite(Date.parse(item.started_at)) &&
      Number.isFinite(Date.parse(item.completed_at)) &&
      Date.parse(item.completed_at) >= Date.parse(item.started_at) &&
      !/^(?:set up job|complete job|post\b)/iu.test(item.name),
  );

  return step?.name ?? null;
}

function checkObservation(check: Check, job: Job | undefined): string {
  const detail = `${check.name}: ${check.status}${check.conclusion ? ` / ${check.conclusion}` : ""}`;

  if (failedCheck(check)) {
    const provider = providerForCheck(check);

    if (provider && reportsProviderLimit(outputText(check))) {
      return `${detail}. Provider limit reported by ${provider}; this does not establish a code failure.`;
    }

    if (
      job &&
      assignedRunner(job) &&
      /\b(?:the runner (?:has )?lost communication with the server|the self-hosted runner (?:went|is) offline)\b/iu.test(
        outputText(check),
      )
    ) {
      return `${detail}. Runner unavailability reported for assigned job ${job.id} (${job.runner_name ?? "unnamed runner"}); no code failure is inferred.`;
    }

    const step = job ? executedFailure(job) : null;

    if (job && step) {
      return `${detail}. Check execution failed in step “${step}” on assigned job ${job.id}. Code versus environment root cause remains unverified.`;
    }

    return `${detail}. Checks failed; cause unknown. A failed conclusion alone does not prove a code or runner failure.`;
  }

  if (check.status !== "completed") {
    return `${detail}. Pending execution or completion; runner availability is unknown.`;
  }

  if (check.conclusion !== "success") {
    return `${detail}. This is not a passing check.`;
  }

  return detail;
}

function statusObservation(status: Status): string {
  const detail = `${status.context}: ${status.state}`;
  const failed = status.state === "failure" || status.state === "error";
  const provider = providerForStatus(status);

  if (failed && provider && reportsProviderLimit(status.description ?? "")) {
    return `${detail}. Provider limit reported by ${provider}; this does not establish a code failure.`;
  }

  if (failed) {
    return `${detail}. Checks failed; cause unknown.`;
  }

  return status.state === "success" ? detail : `${detail}. Completion and cause remain unknown.`;
}

async function collectChecks(
  read: Read,
  coordinates: RepositoryCoordinates,
  sha: string,
  observations: Observations,
) {
  try {
    const result = await read(
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
      {
        ...coordinates,
        ref: sha,
        filter: "latest",
        per_page: CHECK_LIMIT,
        page: 1,
      },
      ChecksSchema,
    );

    observations.checks = result.data.check_runs
      .slice(0, CHECK_LIMIT)
      .filter((check) => check.head_sha.toLowerCase() === sha.toLowerCase());

    if (
      result.metadata.nextUrl ||
      result.data.total_count !== observations.checks.length ||
      result.data.check_runs.length > CHECK_LIMIT
    ) {
      observations.limitations.push(
        "Check-run collection is incomplete, truncated, or includes a different head SHA; unobserved checks remain unknown.",
      );
    }
  } catch {
    observations.limitations.push(
      "Check-run evidence is unavailable; no passing result or failure cause can be inferred from this endpoint.",
    );
  }
}

async function collectStatuses(
  read: Read,
  coordinates: RepositoryCoordinates,
  sha: string,
  observations: Observations,
) {
  try {
    const result = await read(
      "GET /repos/{owner}/{repo}/commits/{ref}/status",
      {
        ...coordinates,
        ref: sha,
        per_page: CHECK_LIMIT,
        page: 1,
      },
      StatusesSchema,
    );

    if (result.data.sha.toLowerCase() !== sha.toLowerCase()) {
      observations.limitations.push(
        "Commit status evidence has a different head SHA and was excluded.",
      );

      return;
    }

    observations.statuses = result.data.statuses.slice(0, CHECK_LIMIT);

    if (
      result.metadata.nextUrl ||
      result.data.total_count !== observations.statuses.length ||
      result.data.statuses.length > CHECK_LIMIT
    ) {
      observations.limitations.push(
        "Commit status collection is incomplete or truncated; unobserved status contexts remain unknown.",
      );
    }
  } catch {
    observations.limitations.push(
      "Commit status evidence is unavailable; unobserved status contexts remain unknown.",
    );
  }
}

async function collectJobs(
  read: Read,
  coordinates: RepositoryCoordinates,
  sha: string,
  observations: Observations,
) {
  const candidates = observations.checks
    .filter((check) => failedCheck(check) || check.status !== "completed")
    .map((check) => ({ checkId: check.id, jobId: actionJobId(check, coordinates) }))
    .filter((candidate) => candidate.jobId !== null);

  if (candidates.length > JOB_LIMIT) {
    observations.limitations.push(
      "Job-detail inspection is capped at five jobs; remaining execution and runner causes are unknown.",
    );
  }

  await Promise.all(
    candidates.slice(0, JOB_LIMIT).map(async (candidate) => {
      if (candidate.jobId === null) {
        return;
      }

      try {
        const { data } = await read(
          "GET /repos/{owner}/{repo}/actions/jobs/{job_id}",
          {
            ...coordinates,
            job_id: candidate.jobId,
          },
          JobSchema,
        );

        if (data.id !== candidate.jobId || data.head_sha.toLowerCase() !== sha.toLowerCase()) {
          observations.limitations.push(
            `Job ${candidate.jobId} does not match the observed head SHA or job identity and was excluded.`,
          );

          return;
        }

        observations.jobs.set(candidate.checkId, data);
      } catch {
        observations.limitations.push(
          `Job ${candidate.jobId} evidence is unavailable; its execution and runner cause remain unknown.`,
        );
      }
    }),
  );
}

function findingBase(repository: string, id: string, title: string, url: string): ReviewFinding {
  return {
    id,
    repository,
    category: "pull_requests",
    title,
    state: "unknown",
    priority: "medium",
    confidence: "low",
    current: "PR evidence is unavailable.",
    desired:
      "Review current head-commit checks, required reviews and branch rules before deciding the PR's next step.",
    nextStep:
      "Inspect the linked PR and refresh its evidence. Obtain approval before changing code, rerunning jobs, merging, closing, or changing provider billing.",
    evidence: [{ url, label: title }],
    approvalRequired: true,
  };
}

function checkEvidence(check: Check, detail: string, fallback: string): Evidence {
  const output = outputText(check);

  return {
    url: publicUrl(check.html_url) ?? publicUrl(check.details_url) ?? fallback,
    label: check.name,
    detail: `${detail}${output ? ` Provider output excerpt: ${output.slice(0, 600)}` : ""}`,
  };
}

async function reviewPullRequest(
  read: Read,
  coordinates: RepositoryCoordinates,
  pr: GitHubPullRequest,
) {
  const repository = `${coordinates.owner}/${coordinates.repo}`;
  const url = `https://github.com/${repository}/pull/${pr.number}`;

  const base = findingBase(
    repository,
    `pull_requests.${pr.number}`,
    `#${pr.number}: ${pr.title}`,
    url,
  );

  const sha = SHA.safeParse(pr.head?.sha);
  const metadata = `Draft: ${pr.draft === true ? "yes" : pr.draft === false ? "no" : "unknown"}. Updated: ${pr.updated_at}.`;

  if (!sha.success) {
    return {
      finding: {
        ...base,
        current: `${metadata} Head SHA is unavailable or invalid; check evidence was not requested.`,
      },
      limitations: [
        `PR #${pr.number}: a valid head SHA was not available; check evidence remains unknown.`,
      ],
    };
  }

  const observations: Observations = { checks: [], statuses: [], jobs: new Map(), limitations: [] };
  await Promise.all([
    collectChecks(read, coordinates, sha.data, observations),
    collectStatuses(read, coordinates, sha.data, observations),
  ]);
  await collectJobs(read, coordinates, sha.data, observations);

  const checkDetails = observations.checks.map((check) =>
    checkObservation(check, observations.jobs.get(check.id)),
  );

  const statusDetails = observations.statuses.map(statusObservation);
  const count = observations.checks.length + observations.statuses.length;

  const failed =
    observations.checks.some(failedCheck) ||
    observations.statuses.some((status) => status.state === "failure" || status.state === "error");

  const allPassing =
    count > 0 &&
    observations.checks.every(
      (check) => check.status === "completed" && check.conclusion === "success",
    ) &&
    observations.statuses.every((status) => status.state === "success");

  const incomplete = observations.limitations.length > 0;

  // Incomplete attribution cannot erase an observed matching-head failure.
  const state = failed
    ? "needs_review"
    : incomplete
      ? "unknown"
      : allPassing
        ? "observed"
        : "unknown";

  const summary =
    count === 0
      ? "No checks or status contexts were observed; missing checks are not success."
      : allPassing && !incomplete
        ? "Observed checks and status contexts passed; merge readiness is not established."
        : incomplete
          ? "Evidence collection is incomplete; overall check coverage remains unknown."
          : "Review the observed check and status evidence.";

  const finding: ReviewFinding = {
    ...base,
    state,
    confidence: incomplete ? (failed ? "medium" : "low") : "high",
    current: `Head SHA: ${sha.data}. ${metadata} ${summary} ${[...checkDetails, ...statusDetails].join(" ")}`,
    evidence: [
      { url, label: `PR #${pr.number}`, detail: `Head SHA: ${sha.data}. ${metadata}` },
      ...observations.checks.map((check, index) =>
        checkEvidence(check, checkDetails[index] ?? "Check evidence", `${url}/checks`),
      ),
      ...observations.statuses.map((status) => ({
        url: publicUrl(status.target_url) ?? `${url}/checks`,
        label: status.context,
        detail: `${statusObservation(status)}${status.description ? ` Provider description: ${status.description.slice(0, 600)}` : ""}`,
      })),
    ],
  };

  return {
    finding,
    limitations: observations.limitations.map((item) => `PR #${pr.number}: ${item}`),
  };
}

/** Bounded public reads only. The supplied client must disable transport-level throttling retries. */
export async function collectPullRequestReview(
  client: GitHubOctokit,
  input: RepositoryCoordinates,
): Promise<PullRequestReview> {
  const coordinates = RepositoryCoordinatesSchema.parse(input);
  const read = boundedReader(client);

  const { data: repo } = await read(
    "GET /repos/{owner}/{repo}",
    coordinates,
    GitHubRepositorySchema,
  );

  if (
    repo.private ||
    (repo.visibility !== null && repo.visibility !== undefined && repo.visibility !== "public")
  ) {
    throw new PrivateRepositoryError(coordinates);
  }

  const repository = `${coordinates.owner}/${coordinates.repo}`;
  const url = `https://github.com/${repository}/pulls`;

  const limitations = [
    "PR review is bounded to five recently updated open PRs, 30 latest check runs and 30 latest status contexts per head SHA, and five matching job details per PR; at most 37 GETs total and two concurrent reads. No logs or later pages are fetched.",
    "Required branch-protection checks, merge queues, review approvals and mergeability are not inspected. Passing observations do not establish readiness to merge. Head SHAs are snapshots; refresh before acting.",
  ];

  try {
    const listing = await read(
      "GET /repos/{owner}/{repo}/pulls",
      {
        ...coordinates,
        state: "open",
        sort: "updated",
        direction: "desc",
        per_page: PR_LIMIT,
        page: 1,
      },
      z.array(GitHubPullRequestSchema).max(100),
    );

    const selected = listing.data.slice(0, PR_LIMIT);

    const reviewed = await Promise.all(
      selected.map((pr) => reviewPullRequest(read, coordinates, pr)),
    );

    const findings = reviewed.map((item) => item.finding);
    limitations.push(...reviewed.flatMap((item) => item.limitations));

    if (listing.metadata.nextUrl || listing.data.length > PR_LIMIT) {
      limitations.push("Open PR listing is truncated; additional open PRs were not inspected.");
      findings.push({
        ...findingBase(
          repository,
          "pull_requests.truncated",
          "Additional pull requests not inspected",
          url,
        ),
        current: "The five-PR review bound was reached; uninspected pull requests remain unknown.",
      });
    } else if (selected.length === 0) {
      findings.push({
        ...findingBase(repository, "pull_requests.none", "No open pull requests observed", url),
        state: "observed",
        confidence: "high",
        current: "GitHub returned no open pull requests in the completed listing.",
        nextStep:
          "No PR action is proposed. Refresh the listing before making a future PR decision.",
      });
    }

    return { findings, limitations };
  } catch {
    limitations.push(
      "Open pull request listing is unavailable; no absence or success can be inferred.",
    );

    return {
      findings: [
        findingBase(
          repository,
          "pull_requests.unavailable",
          "Pull request evidence unavailable",
          url,
        ),
      ],
      limitations,
    };
  }
}
