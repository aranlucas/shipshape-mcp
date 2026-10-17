import { z } from "zod";
import { ConfigObjectSchema, type ConfigDocument, type ConfigValue } from "./config-value";
import type { CheckOutcome } from "./checks/result";
import { inspectDraftJobGuard } from "./draft-job-guard";
import { readTextFile } from "./repository-files";
import type { RepoSnapshot } from "./snapshot";
import { parseWorkflow } from "./workflows";

const REQUIRED_EVENTS = [
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
  "converted_to_draft",
];

const WorkflowEvents = z.union([
  z.string().min(1),
  z.array(z.string()).min(1),
  ConfigObjectSchema.refine((events) => Object.keys(events).length > 0),
]);

function pullRequestOptions(events: ConfigValue | undefined): ConfigValue | undefined {
  if (events === "pull_request" || (Array.isArray(events) && events.includes("pull_request"))) {
    return null;
  }

  return ConfigObjectSchema.safeParse(events).data?.pull_request;
}

function inspectEvents(options: ConfigValue): CheckOutcome[] {
  const parsed = options === null ? {} : ConfigObjectSchema.safeParse(options).data;

  if (!parsed) {
    return [
      { state: "unknown", detail: "The pull_request trigger is not a supported event mapping." },
    ];
  }

  const types =
    parsed.types === undefined
      ? ["opened", "synchronize", "reopened"]
      : z.array(z.string()).safeParse(parsed.types).data;

  if (!types) {
    return [{ state: "unknown", detail: "The pull_request activity types could not be read." }];
  }

  const missing = REQUIRED_EVENTS.filter((event) => !types.includes(event));

  const results: CheckOutcome[] = missing.length
    ? [
        {
          state: "fail",
          detail: `Add pull_request types ${missing.join(", ")} while preserving existing triggers and activity types.`,
        },
      ]
    : [];

  if (Object.hasOwn(parsed, "paths") || Object.hasOwn(parsed, "paths-ignore")) {
    results.push({
      state: "unknown",
      detail:
        "Path filters can prevent the replacement run needed for cancellation. Review trusted cleanup that cancels only older heads and rechecks the current head; never check out PR code in privileged cleanup.",
    });
  }

  return results;
}

interface GroupInspection {
  result: CheckOutcome;
  key?: string;
}

function inspectGroup(value: ConfigValue | undefined, name: string): GroupInspection {
  const parsed = z.string().trim().min(1).safeParse(value);

  if (!parsed.success) {
    return {
      result: {
        state: "fail",
        detail:
          "Declare a workflow concurrency group with a unique workflow prefix and PR number or ref.",
      },
    };
  }

  const text = parsed.data;
  const expressions = [...text.matchAll(/\$\{\{(.*?)\}\}/gsu)];
  const contexts = expressions.map((match) => match[1].replaceAll(/\s/gu, "").toLowerCase());
  const literals = text.replaceAll(/\$\{\{.*?\}\}/gsu, "");

  if (
    contexts.some((context) =>
      /github\.(?:sha|run_id|run_number|run_attempt)\b|pull_request\.head\.sha/u.test(context),
    )
  ) {
    return {
      result: {
        state: "fail",
        detail:
          "Keep concurrency keys stable across commits; remove commit SHAs, run IDs, run numbers and run attempts.",
      },
    };
  }

  const supported = [
    "github.workflow",
    "github.ref",
    "github.event.pull_request.number",
    "github.event.pull_request.number||github.ref",
  ];

  if (literals.includes("${{") || contexts.some((context) => !supported.includes(context))) {
    return {
      result: {
        state: "unknown",
        detail:
          "The concurrency group uses an unsupported expression; review stability and workflow isolation.",
      },
    };
  }

  const identity = contexts.some((context) => supported.slice(1).includes(context));
  const prefix = contexts.includes("github.workflow") || /[\w]/u.test(literals);

  if (!identity || !prefix) {
    return {
      result: {
        state: "fail",
        detail: "Use a unique workflow prefix and PR number or ref in the concurrency group.",
      },
    };
  }

  // Resolve the workflow name to detect shared literal keys and duplicate names.
  const key = text
    .replaceAll(/\$\{\{(.*?)\}\}/gsu, (_match, expression: string) => {
      const context = expression.replaceAll(/\s/gu, "").toLowerCase();

      const prContext =
        context === "github.event.pull_request.number||github.ref"
          ? "github.event.pull_request.number"
          : context;

      return context === "github.workflow" ? name : `\${{${prContext}}}`;
    })
    .toLowerCase();

  return { key, result: { state: "pass" } };
}

function cancellationEnabled(value: ConfigValue | undefined): boolean | null {
  if (value === true || value === false || value === undefined) {
    return value === true;
  }

  const parsed = z.string().safeParse(value);

  if (!parsed.success) {
    return null;
  }

  const text = parsed.data.trim();

  const expression = (
    text.startsWith("${{") && text.endsWith("}}") ? text.slice(3, -2) : text
  ).trim();

  return /^(?:true|github\.event_name\s*==\s*'pull_request'|'pull_request'\s*==\s*github\.event_name)$/iu.test(
    expression,
  )
    ? true
    : expression === "false"
      ? false
      : null;
}

function inspectJobs(workflow: ConfigDocument): CheckOutcome[] {
  const jobs = ConfigObjectSchema.safeParse(workflow.jobs).data;

  if (!jobs || !Object.keys(jobs).length) {
    return [{ state: "unknown", detail: "Workflow jobs could not be read or are empty." }];
  }

  return Object.entries(jobs).flatMap(([id, value]) => {
    const job = ConfigObjectSchema.safeParse(value).data;

    if (!job) {
      return [{ state: "unknown", detail: `jobs.${id} could not be read.` }];
    }

    const guard = inspectDraftJobGuard(job.if);

    const results: CheckOutcome[] =
      guard === true
        ? []
        : [
            {
              state: guard === false ? "fail" : "unknown",
              detail:
                guard === false
                  ? `Add github.event.pull_request.draft != true as a mandatory AND condition to jobs.${id}.if, preserving its existing condition. Step guards do not prevent runner allocation.`
                  : `Review jobs.${id}.if; its draft exclusion could not be established statically.`,
            },
          ];

    if (job.uses !== undefined) {
      results.push({
        state: "unknown",
        detail: `Review reusable workflow jobs.${id}: caller and callee concurrency keys must be distinct because github.workflow is inherited. Called workflow internals are not verified.`,
      });
    }

    if (job.concurrency !== undefined) {
      results.push({
        state: "unknown",
        detail: `Review jobs.${id}.concurrency for collisions with workflow and sibling job groups.`,
      });
    }

    return results;
  });
}

export function inspectPrWorkflowEfficiency(snapshot: RepoSnapshot): CheckOutcome {
  if (!snapshot.tree) {
    return { state: "unknown", detail: snapshot.treeError ?? "Repository tree unavailable." };
  }

  const paths = [...snapshot.tree.paths]
    .filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path))
    .toSorted();

  const results: CheckOutcome[] = [];
  const groups = new Map<string, string>();
  const inspected: string[] = [];

  for (const path of paths) {
    const file = readTextFile(snapshot, path);
    const workflow = file.status === "available" ? parseWorkflow(file.value) : null;

    if (!workflow) {
      results.push({
        state: "unknown",
        path,
        detail:
          file.status === "unavailable" ? file.detail : "Workflow could not be read or parsed.",
      });
      continue;
    }

    const triggers = WorkflowEvents.safeParse(workflow.on);

    if (!triggers.success) {
      results.push({ state: "unknown", path, detail: "Workflow triggers could not be read." });
      continue;
    }

    const options = pullRequestOptions(triggers.data);

    if (options === undefined) {
      continue;
    }

    inspected.push(path);
    const concurrency = ConfigObjectSchema.safeParse(workflow.concurrency).data;

    const group = inspectGroup(
      concurrency?.group,
      z.string().safeParse(workflow.name).data ?? path,
    );

    const cancellation = cancellationEnabled(concurrency?.["cancel-in-progress"]);
    const inspections = [...inspectEvents(options), group.result, ...inspectJobs(workflow)];

    if (cancellation !== true) {
      inspections.push({
        state: cancellation === false ? "fail" : "unknown",
        detail:
          "Enable workflow cancel-in-progress for every pull_request activity, including converted_to_draft; conditional cancellation requires review.",
      });
    }

    if (group.key) {
      const other = groups.get(group.key);

      if (other) {
        inspections.push({
          state: "fail",
          detail: `Concurrency group collides with ${other}; use a unique workflow prefix.`,
        });
      }

      groups.set(group.key, path);
    }

    results.push(...inspections.map((result) => ({ ...result, path })));
  }

  return (
    results.find((result) => result.state === "fail") ??
    results.find((result) => result.state === "unknown") ??
    (snapshot.tree.truncated
      ? { state: "unknown", detail: "The repository tree was truncated." }
      : {
          state: "pass",
          path: inspected[0] ?? null,
          detail: inspected.length
            ? `All ${inspected.length} pull_request workflows declare cancellation, lifecycle events and job-level draft guards. Static evidence does not prove runtime cancellation.`
            : "No pull_request workflows found.",
        })
  );
}
