import { useEffect, useRef, useState } from "preact/hooks";
import type {
  CheckResult,
  OverviewResponse,
  RepoDetailResponse,
  RepoSummary,
} from "../../api/contract";
import { api, ApiError } from "../api";
import { evidenceLink } from "../evidence";
import { STATE_WORDS, timeAgo } from "../format";
import { linkHandler, navigate, paths } from "../router";
import { startTask } from "../tasks";
import { StateMark } from "./state-mark";

interface RepoPanelProps {
  owner: string;
  name: string;
  overview: OverviewResponse;
  onRefresh: (repo?: string) => Promise<void>;
}

interface LoadedRepoDetail {
  fullName: string;
  detail: RepoDetailResponse;
}

type Entry = RepoDetailResponse["practices"][number];

interface CheckProps {
  check: CheckResult;
}

interface PracticeEntryProps {
  entry: Entry;
  repo: RepoSummary;
}

interface Section {
  state: "fail" | "unknown" | "pass" | "not_applicable" | "pending";
  open: boolean;
  entries: Entry[];
}

function close() {
  navigate(paths.overview);
}

/** Behind and couldn't-check are expanded; following and doesn't-apply fold away. */
function sectionsFor(detail: RepoDetailResponse | null): Section[] {
  if (!detail) {
    return [];
  }

  const valid = detail.practices.filter((entry) => entry.practice.valid);
  const checked = valid.filter((entry) => entry.result.checkedAt !== null);

  const sections: Section[] = [
    {
      state: "pending",
      open: true,
      entries: valid.filter((entry) => entry.result.checkedAt === null),
    },
    {
      state: "fail",
      open: true,
      entries: checked.filter((entry) => entry.result.state === "fail"),
    },
    {
      state: "unknown",
      open: true,
      entries: checked.filter((entry) => entry.result.state === "unknown"),
    },
    { state: "pass", open: false, entries: valid.filter((entry) => entry.result.state === "pass") },
    {
      state: "not_applicable",
      open: false,
      entries: valid.filter((entry) => entry.result.state === "not_applicable"),
    },
  ];

  return sections.filter((section) => section.entries.length > 0);
}

const NOT_SET = new Set([null, "false"]);

/** One plain sentence per failing or unknown check, phrased for its type. */
function outcome(check: CheckResult): string | null {
  if (check.state === "unknown") {
    return check.detail ?? "Shipshape couldn't read what this check needs.";
  }

  if (check.state !== "fail") {
    return null;
  }

  const where = check.path ?? "The file";

  switch (check.type) {
    case "file-exists":
      return check.expected === "false" ? `${where} should not exist.` : `${where} is missing.`;
    case "file-matches":
      return check.actual === null
        ? `${where} is missing.`
        : `${where} differs from the catalog copy.`;
    case "file-contains":
      return check.actual === null
        ? `${where} is missing.`
        : `${where} doesn't contain the expected text.`;
    case "json-path":
    case "yaml-path":
      if (check.actual === null) {
        return (
          check.detail ?? (NOT_SET.has(check.expected) ? "Present but shouldn't be." : "Not set.")
        );
      }

      break;
    default:
      break;
  }

  if (check.expected !== null && check.actual !== null) {
    return `Expected ${check.expected}, found ${check.actual}.`;
  }

  return check.detail ?? "This check didn't pass.";
}

function FileComparison({ check }: CheckProps) {
  if (check.type !== "file-matches" || check.state !== "fail" || check.actual === null) {
    return null;
  }

  return (
    <details class="compare">
      <summary>Compare with the catalog copy</summary>
      <div class="compare-panes">
        <figure>
          <figcaption>Catalog</figcaption>
          <pre>{check.expected}</pre>
        </figure>
        <figure>
          <figcaption>This repository</figcaption>
          <pre>{check.actual}</pre>
        </figure>
      </div>
    </details>
  );
}

function PracticeEntry({ entry, repo }: PracticeEntryProps) {
  const { practice, result, checks } = entry;
  const href = paths.practice(practice.id);

  return (
    <li class={`entry entry-${result.state}`}>
      <div class="entry-head">
        <StateMark state={result.checkedAt ? result.state : "pending"} />
        <a href={href} onClick={linkHandler(href)} class="entry-title">
          {practice.title}
        </a>
      </div>
      <p class="entry-evidence">
        {result.checkedAt
          ? `Checked ${timeAgo(result.checkedAt)}`
          : "Not checked against the current catalog yet"}
        {practice.kind === "files" && entry.headSha && ` · commit ${entry.headSha.slice(0, 7)}`}
        {practice.kind === "settings" && result.checkedAt && " · live settings at check time"}
      </p>
      {result.state === "not_applicable" && (
        <p class="entry-evidence">Outside this practice’s repository applicability rules.</p>
      )}
      {checks.length > 0 && (
        <ul class="checks">
          {checks.map((check) => (
            <li key={check.label} class={`check check-${check.state}`}>
              <span class="check-label">{check.label}</span>
              <span class="check-outcome">
                {check.state === "pass" ? (check.detail ?? "Check passed.") : outcome(check)}
              </span>
              {evidenceLink(repo, entry.headSha, check) && (
                <a
                  href={evidenceLink(repo, entry.headSha, check) ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                >
                  View source at checked commit
                </a>
              )}
              <FileComparison check={check} />
            </li>
          ))}
        </ul>
      )}
      {result.state === "fail" && (
        <a class="button button-small" href={href} onClick={linkHandler(href)}>
          View practice and fix instructions
        </a>
      )}
    </li>
  );
}

export function RepoPanel({ owner, name, overview, onRefresh }: RepoPanelProps) {
  const fullName = `${owner}/${name}`;
  const summary = overview.repos.find((item) => item.fullName === fullName);
  // Overview polling returns new objects even when this repository hasn't changed.
  const revision = JSON.stringify([overview.catalog.sha, summary, overview.results[fullName]]);
  const [loaded, setLoaded] = useState<LoadedRepoDetail | null>(null);
  const detail = loaded?.fullName === fullName ? loaded.detail : null;
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let current = true;

    setError(null);
    api
      .repo(owner, name)
      .then((value) => current && setLoaded({ fullName, detail: value }))
      .catch(
        (cause: unknown) =>
          current &&
          setError(
            cause instanceof ApiError ? cause.message : "The repository couldn't be loaded.",
          ),
      );

    return () => {
      current = false;
    };
  }, [owner, name, revision]);

  useEffect(() => {
    heading.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  }, [fullName]);

  const sections = sectionsFor(detail);

  const neverChecked = detail?.practices.every((entry) => entry.result.checkedAt === null) ?? false;

  const repo = detail?.repo ?? summary;

  const checkedAt =
    detail?.practices.find((entry) => entry.result.checkedAt)?.result.checkedAt ?? null;

  return (
    <>
      <div class="scrim" onClick={close} />
      <aside class="panel" aria-labelledby="panel-title">
        <header class="panel-head">
          <div>
            <p class="panel-owner">{owner}</p>
            <h2 id="panel-title" ref={heading} tabIndex={-1}>
              {name}
            </h2>
          </div>
          <button type="button" class="button button-quiet" onClick={close}>
            Close
          </button>
        </header>

        {repo && (
          <dl class="facts">
            <div>
              <dt>Visibility</dt>
              <dd>{repo.private ? "Private" : "Public"}</dd>
            </div>
            <div>
              <dt>Language</dt>
              <dd>{repo.language ?? "None detected"}</dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd>{repo.defaultBranch}</dd>
            </div>
            <div>
              <dt>Checked</dt>
              <dd>{timeAgo(checkedAt)}</dd>
            </div>
          </dl>
        )}

        <div class="panel-actions">
          {repo && (
            <a class="button button-quiet" href={repo.url} target="_blank" rel="noreferrer">
              Open on GitHub
            </a>
          )}
          <button
            type="button"
            class="button button-quiet"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              startTask(onRefresh(fullName).finally(() => setRefreshing(false)));
            }}
          >
            {refreshing ? "Checking…" : "Check again"}
          </button>
        </div>

        {error && <p class="notice notice-error">{error}</p>}
        {!detail && !error && <p class="loading">Loading checks…</p>}
        {neverChecked && (
          <p class="notice">
            Shipshape hasn't checked this repository yet. Use Check again to queue it now.
          </p>
        )}

        {repo &&
          sections.map((section) => (
            <section key={section.state} class="panel-section">
              {section.open ? (
                <>
                  <h3>
                    {STATE_WORDS[section.state]}{" "}
                    <span class="section-count">{section.entries.length}</span>
                  </h3>
                  <ul class="entries">
                    {section.entries.map((entry) => (
                      <PracticeEntry key={entry.practice.id} entry={entry} repo={repo} />
                    ))}
                  </ul>
                </>
              ) : (
                <details>
                  <summary>
                    {STATE_WORDS[section.state]}{" "}
                    <span class="section-count">{section.entries.length}</span>
                  </summary>
                  <ul class="entries">
                    {section.entries.map((entry) => (
                      <PracticeEntry key={entry.practice.id} entry={entry} repo={repo} />
                    ))}
                  </ul>
                </details>
              )}
            </section>
          ))}

        {sections.some((section) => section.state === "fail") && (
          <p id="fix-note" class="panel-foot">
            Fix instructions come from your current catalog. These checks are read-only; changes are
            made through a separately reviewed pull request.
          </p>
        )}
      </aside>
    </>
  );
}
