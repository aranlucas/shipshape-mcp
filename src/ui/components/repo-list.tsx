import type { OverviewResponse, PracticeSummary } from "../../api/contract";
import { STATE_WORDS, plural } from "../format";
import { cellState, repoGaps, type RepoTally } from "../model";
import { linkHandler, paths } from "../router";
import { StateMark } from "./state-mark";

interface RepoListProps {
  overview: OverviewResponse;
  practices: PracticeSummary[];
  groups: Array<{ owner: string; tallies: RepoTally[] }>;
  selected: string | null;
  /** The practice column to highlight in every row. */
  highlight: string | null;
}

const list = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

const NAMED = 3;

/** Names a few practices in full; the repository panel lists the rest. */
function titles(practices: PracticeSummary[]): string {
  const named = practices.length > NAMED ? practices.slice(0, NAMED - 1) : practices;
  const rest = practices.length - named.length;

  return list.format([
    ...named.map((practice) => practice.title),
    ...(rest > 0 ? [`${rest} more`] : []),
  ]);
}

interface RepoNoteProps {
  overview: OverviewResponse;
  tally: RepoTally;
}

function RepoNote({ overview, tally }: RepoNoteProps) {
  const gaps = repoGaps(overview, tally.repo.fullName);

  if (gaps.behind.length === 0 && gaps.unknown.length === 0) {
    if (!tally.checked) {
      return <p class="repo-note">Not fully checked yet</p>;
    }

    return (
      <p class="repo-note">
        {tally.applies === 0
          ? "No practices apply"
          : `Follows ${tally.applies === 1 ? "the one practice" : `all ${tally.applies} practices`} that apply`}
      </p>
    );
  }

  return (
    <p class="repo-note">
      {gaps.behind.length > 0 && <span class="note-behind">Behind on {titles(gaps.behind)}. </span>}
      {gaps.unknown.length > 0 &&
        (gaps.behind.length > 0 ? (
          <span>Couldn't check {plural(gaps.unknown.length, "other practice")}.</span>
        ) : (
          <span>Couldn't check {titles(gaps.unknown)}.</span>
        ))}
    </p>
  );
}

/**
 * One row per repository: its name, what it's behind on in words, and a
 * strip with one mark per practice in the same order as the practice list.
 */
export function RepoList({ overview, practices, groups, selected, highlight }: RepoListProps) {
  return (
    <div class="repo-groups" style={{ "--practices": practices.length }}>
      {groups.map((group) => (
        <section key={group.owner} class="owner" aria-labelledby={`owner-${group.owner}`}>
          <h2 id={`owner-${group.owner}`} class="owner-head">
            <span class="owner-name">{group.owner}</span>
            <span class="owner-count">
              {plural(group.tallies.length, "repository", "repositories")}
            </span>
          </h2>
          <ul class="repos">
            {group.tallies.map((tally) => {
              const { repo } = tally;
              const href = paths.repo(repo.fullName);

              return (
                <li
                  key={repo.fullName}
                  class={`repo${selected === repo.fullName ? " is-selected" : ""}`}
                  onClick={linkHandler(href)}
                >
                  <div class="repo-main">
                    <a href={href} onClick={linkHandler(href)} class="repo-link">
                      {repo.name}
                    </a>
                    {repo.private && (
                      <svg
                        class="lock"
                        viewBox="0 0 12 12"
                        width="11"
                        height="11"
                        role="img"
                        aria-label="Private"
                      >
                        <rect x="2" y="5.5" width="8" height="5.5" rx="1" />
                        <path d="M4 5.5 V4 a2 2 0 0 1 4 0 V5.5" />
                      </svg>
                    )}
                    {(repo.fork || repo.archived) && (
                      <span class="repo-flag">{repo.fork ? "fork" : "archived"}</span>
                    )}
                    <RepoNote overview={overview} tally={tally} />
                  </div>
                  <span class="repo-behind">
                    {tally.behind > 0 && (
                      <span aria-label={`Behind on ${plural(tally.behind, "practice")}`}>
                        {tally.behind}
                      </span>
                    )}
                  </span>
                  <span class="marks">
                    {practices.map((practice, index) => {
                      const state = cellState(overview, repo.fullName, practice.id);

                      const firstSettings =
                        practice.kind === "settings" && practices[index - 1]?.kind === "files";

                      return (
                        <span
                          key={practice.id}
                          class={`mark-slot${firstSettings ? " group-start" : ""}${highlight === practice.id ? " is-highlighted" : ""}`}
                          title={`${practice.title}: ${STATE_WORDS[state]}`}
                        >
                          <StateMark
                            state={state}
                            loading={overview.results[repo.fullName]?.[practice.id]?.retrying}
                            label={`${practice.title}: ${STATE_WORDS[state]}`}
                          />
                        </span>
                      );
                    })}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
