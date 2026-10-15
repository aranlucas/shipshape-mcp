import type { OverviewResponse } from "../../api/contract";
import { Distribution } from "../components/distribution";
import { practiceCounts, practiceGroups } from "../model";
import { linkHandler, paths } from "../router";

interface PracticesProps {
  overview: OverviewResponse;
}

export function Practices({ overview }: PracticesProps) {
  const groups = practiceGroups(overview.practices, { includeInvalid: true });

  return (
    <>
      <header class="page-head">
        <div>
          <h1>Practices</h1>
          <p class="page-lead">
            Your catalog lives in <code>{overview.catalog.repo}</code>. Edits here are committed
            there, and every repository is checked again.
          </p>
        </div>
        <a
          class="button button-primary"
          href={paths.newPractice}
          onClick={linkHandler(paths.newPractice)}
        >
          Add a practice
        </a>
      </header>

      {groups.map((group) => (
        <section key={group.kind} class="practice-group" aria-labelledby={`group-${group.kind}`}>
          <h2 id={`group-${group.kind}`}>{group.label}</h2>
          <ul class="practice-list">
            {group.practices.map((practice) => {
              const href = paths.practice(practice.id);
              const counts = practiceCounts(overview, practice.id);

              return (
                <li key={practice.id} class={practice.valid ? undefined : "is-invalid"}>
                  <a href={href} onClick={linkHandler(href)} class="practice-link">
                    {practice.title}
                  </a>
                  <p class="practice-summary">
                    {practice.valid
                      ? practice.summary
                      : `This practice is invalid: ${practice.error ?? "unknown error"}`}
                  </p>
                  <Distribution counts={counts} compact />
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}
