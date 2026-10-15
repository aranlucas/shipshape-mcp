import { useEffect, useRef, useState } from "preact/hooks";
import type { CheckResult, OverviewResponse, RepoDetailResponse } from "../../api/contract";
import { api, ApiError } from "../api";
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

type Entry = RepoDetailResponse["practices"][number];

interface PracticeEntryProps {
  entry: Entry;
  open: boolean;
}

interface Section {
  state: "fail" | "unknown" | "pass" | "not_applicable";
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

function outcome(check: CheckResult): string | null {
  if (check.state === "unknown") {
    return check.detail ?? "Shipshape couldn't read what this check needs.";
  }

  if (check.state !== "fail") {
    return null;
  }

  if (check.actual === "missing") {
    return check.path ? `${check.path} is missing.` : "Missing.";
  }

  if (check.expected && check.actual) {
    return `Expected ${check.expected}, found ${check.actual}.`;
  }

  return check.detail ?? "This check didn't pass.";
}

function PracticeEntry({ entry, open }: PracticeEntryProps) {
  const { practice, result, checks } = entry;
  const href = paths.practice(practice.id);
  const relevant = checks.filter((check) => check.state !== "pass");

  return (
    <li class={`entry entry-${result.state}`}>
      <div class="entry-head">
        <StateMark state={result.checkedAt ? result.state : "pending"} />
        <a href={href} onClick={linkHandler(href)} class="entry-title">
          {practice.title}
        </a>
      </div>
      {open && relevant.length > 0 && (
        <ul class="checks">
          {relevant.map((check) => (
            <li key={check.label} class={`check check-${check.state}`}>
              <span class="check-label">{check.label}</span>
              <span class="check-outcome">{outcome(check)}</span>
            </li>
          ))}
        </ul>
      )}
      {result.state === "fail" && (
        <button type="button" class="button button-small" disabled aria-describedby="fix-note">
          Request fix
        </button>
      )}
    </li>
  );
}

export function RepoPanel({ owner, name, overview, onRefresh }: RepoPanelProps) {
  const fullName = `${owner}/${name}`;
  const [detail, setDetail] = useState<RepoDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let current = true;

    setDetail(null);
    setError(null);
    api
      .repo(owner, name)
      .then((value) => current && setDetail(value))
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
  }, [owner, name, overview]);

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

  const repo = detail?.repo ?? overview.repos.find((item) => item.fullName === fullName);

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

        {sections.map((section) => (
          <section key={section.state} class="panel-section">
            {section.open ? (
              <>
                <h3>
                  {STATE_WORDS[section.state]}{" "}
                  <span class="section-count">{section.entries.length}</span>
                </h3>
                <ul class="entries">
                  {section.entries.map((entry) => (
                    <PracticeEntry key={entry.practice.id} entry={entry} open />
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
                    <PracticeEntry key={entry.practice.id} entry={entry} open={false} />
                  ))}
                </ul>
              </details>
            )}
          </section>
        ))}

        {sections.some((section) => section.state === "fail") && (
          <p id="fix-note" class="panel-foot">
            Request fix will hand the practice to an agent that opens a pull request. It isn't
            available yet; the checks above show what to change.
          </p>
        )}
      </aside>
    </>
  );
}
