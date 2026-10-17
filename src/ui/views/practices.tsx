import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { OverviewResponse } from "../../api/contract";
import { ApiError } from "../api";
import { Distribution } from "../components/distribution";
import { practiceCounts, practiceGroups } from "../model";
import { resetPracticeMutationOptions } from "../mutations";
import { ORIGIN_LABELS } from "../origin";
import { linkHandler, paths } from "../router";

interface PracticesProps {
  overview: OverviewResponse;
}

export function Practices({ overview }: PracticesProps) {
  const client = useQueryClient();
  const groups = practiceGroups(overview.practices, { includeInvalid: true });
  const turnOn = useMutation(resetPracticeMutationOptions(client));
  const { disabled, repo } = overview.catalog;

  return (
    <>
      <header class="page-head">
        <div>
          <h1>Practices</h1>
          <p class="page-lead">
            Built-in practices ship with Shipshape. Your edits and own practices live in{" "}
            <code>{repo}</code>; saving commits there, and every repository is checked again.
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
                  <p class="practice-heading">
                    <a href={href} onClick={linkHandler(href)} class="practice-link">
                      {practice.title}
                    </a>
                    <span class={`origin origin-${practice.origin}`}>
                      {ORIGIN_LABELS[practice.origin]}
                    </span>
                  </p>
                  <p class="practice-summary">
                    {practice.valid
                      ? practice.summary
                      : `This practice is invalid: ${practice.error ?? "unknown error"}`}
                  </p>
                  {practice.matchesBuiltIn && (
                    <p class="origin-note">
                      Your copy is identical to the built-in, so built-in updates don't reach it.{" "}
                      <a href={href} onClick={linkHandler(href)}>
                        Reset it
                      </a>{" "}
                      to follow the built-in.
                    </p>
                  )}
                  <Distribution counts={counts} compact />
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {disabled.length > 0 && (
        <section class="practice-group" aria-labelledby="group-disabled">
          <h2 id="group-disabled">Turned off</h2>
          {turnOn.error && (
            <p class="notice notice-error" role="alert">
              {turnOn.error instanceof ApiError
                ? turnOn.error.message
                : "The practice couldn't be turned back on."}
            </p>
          )}
          <ul class="practice-list">
            {disabled.map((practice) => (
              <li key={practice.id} class="is-off">
                <p class="practice-heading">
                  <span class="practice-link">{practice.title}</span>
                  <button
                    type="button"
                    class="button button-quiet button-small push-end"
                    disabled={turnOn.isPending}
                    onClick={() => turnOn.mutate(practice.id)}
                  >
                    {turnOn.isPending && turnOn.variables === practice.id
                      ? "Turning on…"
                      : "Turn back on"}
                  </button>
                </p>
                <p class="practice-summary">{practice.summary}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
