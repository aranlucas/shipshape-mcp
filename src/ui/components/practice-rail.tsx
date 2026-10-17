import type { OverviewResponse, PracticeSummary } from "../../api/contract";
import { plural, timeAgo } from "../format";
import { practiceCounts } from "../model";
import { linkHandler, paths } from "../router";
import { Strip } from "./distribution";

interface PracticeRailProps {
  overview: OverviewResponse;
  groups: Array<{ kind: string; label: string; practices: PracticeSummary[] }>;
  focused: string | null;
  onFocus: (id: string | null) => void;
  onHover: (id: string | null) => void;
}

/**
 * Every adopted practice, written out in full. Choosing one narrows the
 * repository list to the repositories that still need work on it.
 */
export function PracticeRail({ overview, groups, focused, onFocus, onHover }: PracticeRailProps) {
  const total = groups.reduce((sum, group) => sum + group.practices.length, 0);

  return (
    <aside class="rail" aria-labelledby="rail-title">
      <header class="rail-head">
        <h2 id="rail-title">{plural(total, "practice")}</h2>
        <p>
          From{" "}
          <a href={paths.practices} onClick={linkHandler(paths.practices)}>
            {overview.catalog.repo}
          </a>
          , loaded {timeAgo(overview.catalog.loadedAt)}.
        </p>
      </header>

      {groups.map((group) => (
        <section key={group.kind} class="rail-group" aria-labelledby={`rail-${group.kind}`}>
          <h3 id={`rail-${group.kind}`}>{group.label}</h3>
          <ul>
            {group.practices.map((practice) => {
              const counts = practiceCounts(overview, practice.id);
              const pressed = focused === practice.id;

              return (
                <li key={practice.id}>
                  <button
                    type="button"
                    class="rail-practice"
                    aria-pressed={pressed}
                    title={practice.summary}
                    onClick={() => onFocus(pressed ? null : practice.id)}
                    onMouseEnter={() => onHover(practice.id)}
                    onMouseLeave={() => onHover(null)}
                    onFocus={() => onHover(practice.id)}
                    onBlur={() => onHover(null)}
                  >
                    <span class="rail-title">{practice.title}</span>
                    <span class={`rail-count${counts.fail > 0 ? " is-behind" : ""}`}>
                      {counts.fail > 0 ? `${counts.fail} behind` : "None behind"}
                    </span>
                    <Strip counts={counts} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </aside>
  );
}
