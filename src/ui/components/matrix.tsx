import type { OverviewResponse } from "../../api/contract";
import { STATE_WORDS, plural } from "../format";
import { cellState, practiceCounts, practiceGroups, type RepoTally } from "../model";
import { linkHandler, paths } from "../router";
import { Legend } from "./legend";
import { StateMark } from "./state-mark";

interface MatrixProps {
  overview: OverviewResponse;
  groups: Array<{ owner: string; tallies: RepoTally[] }>;
  selected: string | null;
}

export function Matrix({ overview, groups, selected }: MatrixProps) {
  const columns = practiceGroups(overview.practices);
  const practices = columns.flatMap((group) => group.practices);
  const span = practices.length + 2;

  return (
    <div class="matrix-scroll">
      <table class="matrix">
        <caption class="sr-only">Practices followed by each repository</caption>
        <colgroup>
          <col class="col-repo" />
          <col class="col-count" />
          {columns.map((group) => (
            <colgroup key={group.kind} span={group.practices.length} class={`cols-${group.kind}`} />
          ))}
        </colgroup>
        <thead>
          <tr class="practice-row">
            <th scope="col" class="corner">
              <Legend />
              <span class="corner-label">Repository</span>
            </th>
            <th scope="col" class="count-head">
              <span class="sr-only">Practices behind</span>
            </th>
            {practices.map((practice, index) => {
              const behind = practiceCounts(overview, practice.id).fail;

              const firstSettings =
                practice.kind === "settings" && practices[index - 1]?.kind !== "settings";

              return (
                <th
                  key={practice.id}
                  scope="col"
                  class={`practice-head${practice.valid ? "" : " is-invalid"}${firstSettings ? " group-start" : ""}`}
                >
                  <a
                    href={paths.practice(practice.id)}
                    onClick={linkHandler(paths.practice(practice.id))}
                    title={`${practice.title}: ${practice.summary}`}
                  >
                    <span class="practice-label">{practice.title}</span>
                  </a>
                  <span
                    class="practice-behind"
                    aria-label={`${plural(behind, "repository", "repositories")} behind`}
                  >
                    {behind > 0 ? behind : ""}
                  </span>
                </th>
              );
            })}
          </tr>
          <tr class="kind-row">
            <td colSpan={2} />
            {columns.map((group) => (
              <th
                key={group.kind}
                colSpan={group.practices.length}
                scope="colgroup"
                class={`kind-${group.kind}${group.kind === "settings" && columns.length > 1 ? " group-start" : ""}`}
              >
                <span>{group.label}</span>
              </th>
            ))}
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.owner}>
            <tr class="owner-row">
              <th colSpan={span} scope="rowgroup">
                <span class="owner-name">{group.owner}</span>
                <span class="owner-count">
                  {plural(group.tallies.length, "repository", "repositories")}
                </span>
              </th>
            </tr>
            {group.tallies.map((tally) => {
              const { repo } = tally;
              const href = paths.repo(repo.fullName);

              return (
                <tr
                  key={repo.fullName}
                  class={selected === repo.fullName ? "is-selected" : undefined}
                >
                  <th scope="row" class="repo-cell">
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
                  </th>
                  <td class="count-cell">
                    {tally.behind > 0 ? (
                      <span
                        class="behind-count"
                        aria-label={`Behind on ${plural(tally.behind, "practice")}`}
                      >
                        {tally.behind}
                      </span>
                    ) : null}
                  </td>
                  {practices.map((practice, index) => {
                    const state = cellState(overview, repo.fullName, practice.id);

                    const firstSettings =
                      practice.kind === "settings" && practices[index - 1]?.kind !== "settings";

                    return (
                      <td
                        key={practice.id}
                        class={`cell${firstSettings ? " group-start" : ""}`}
                        onClick={linkHandler(href)}
                      >
                        <StateMark
                          state={state}
                          label={`${practice.title}: ${STATE_WORDS[state]}`}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
    </div>
  );
}
