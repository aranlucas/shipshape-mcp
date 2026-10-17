import { useMemo, useState } from "preact/hooks";
import type { OverviewResponse } from "../../api/contract";
import { Legend } from "../components/legend";
import { PracticeRail } from "../components/practice-rail";
import { RepoList } from "../components/repo-list";
import { RepoPanel } from "../components/repo-panel";
import { plural } from "../format";
import { compareTallies, needsAttention, practiceGroups, summarize, tallyRepo } from "../model";
import { linkHandler, paths } from "../router";

interface OverviewProps {
  overview: OverviewResponse;
  login: string;
  repo: { owner: string; name: string } | null;
  onRefresh: (repo?: string) => void;
  refreshing: boolean;
}

export function Overview({ overview, login, repo, onRefresh, refreshing }: OverviewProps) {
  const [owner, setOwner] = useState("");
  const [query, setQuery] = useState("");
  const [behindOnly, setBehindOnly] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const tallies = useMemo(
    () => overview.repos.map((item) => tallyRepo(overview, item)),
    [overview],
  );

  const active = tallies.filter((tally) => !tally.repo.fork && !tally.repo.archived);
  const summary = summarize(active);

  const owners = [...new Set(overview.repos.map((item) => item.owner))].toSorted((a, b) =>
    a === login ? -1 : b === login ? 1 : a.localeCompare(b),
  );

  const needle = query.trim().toLowerCase();
  const columns = practiceGroups(overview.practices);
  const practices = columns.flatMap((group) => group.practices);
  const focus = practices.find((practice) => practice.id === focused) ?? null;

  const focusCount = focus
    ? active.filter((tally) => needsAttention(overview, tally.repo.fullName, focus.id)).length
    : 0;

  const visible = (showInactive ? tallies : active)
    .filter((tally) => !owner || tally.repo.owner === owner)
    .filter((tally) => !needle || tally.repo.name.toLowerCase().includes(needle))
    .filter((tally) => !behindOnly || tally.behind > 0)
    .filter((tally) => !focus || needsAttention(overview, tally.repo.fullName, focus.id));

  const groups = owners.flatMap((name) => {
    const ownerTallies = visible
      .filter((tally) => tally.repo.owner === name)
      .toSorted(compareTallies);

    return ownerTallies.length > 0 ? [{ owner: name, tallies: ownerTallies }] : [];
  });

  const invalid = overview.practices.filter((practice) => !practice.valid);
  const selected = repo ? `${repo.owner}/${repo.name}` : null;
  const hidden = tallies.length - active.length;

  if (overview.repos.length === 0) {
    return (
      <section class="empty-state">
        <h1>No repositories yet</h1>
        <p>
          Use Find my repositories to load repositories from your GitHub App installations and run
          their first checks.
        </p>
        <p>
          <a href="https://github.com/aranlucas/shipshape-mcp/blob/main/docs/setup.md">
            Read the setup guide
          </a>
        </p>
      </section>
    );
  }

  if (overview.practices.length === 0) {
    return (
      <section class="empty-state">
        <h1>Your catalog is empty</h1>
        <p>Practices you add are checked against every repository.</p>
        <p>
          <a
            class="button button-primary"
            href={paths.newPractice}
            onClick={linkHandler(paths.newPractice)}
          >
            Add a practice
          </a>
        </p>
      </section>
    );
  }

  return (
    <>
      <section class="status" aria-labelledby="status-line">
        <h1 id="status-line" class="status-line">
          {summary.clear} of {summary.applicable} repositories follow every practice that applies.
        </h1>
        <p class="status-detail">
          {summary.behindRepos > 0 &&
            `${plural(summary.behindRepos, "repository is", "repositories are")} behind. `}
          {summary.unknownRepos > 0 &&
            `${plural(summary.unknownRepos, "repository has", "repositories have")} checks Shipshape couldn't run. `}
          {summary.unchecked > 0 &&
            `${plural(summary.unchecked, "repository hasn't", "repositories haven't")} been fully checked against the current catalog yet.`}
        </p>
      </section>

      {invalid.length > 0 && (
        <p class="notice notice-error">
          {invalid.length === 1 ? "One practice isn't" : `${invalid.length} practices aren't`} being
          checked because {invalid.length === 1 ? "its definition is" : "their definitions are"}{" "}
          invalid:{" "}
          {invalid.map((practice, index) => (
            <span key={practice.id}>
              {index > 0 && ", "}
              <a
                href={paths.practice(practice.id)}
                onClick={linkHandler(paths.practice(practice.id))}
              >
                {practice.id}
              </a>
            </span>
          ))}
          .
        </p>
      )}

      <div class="board">
        <PracticeRail
          overview={overview}
          groups={columns}
          focused={focus?.id ?? null}
          onFocus={setFocused}
          onHover={setHovered}
        />

        <section class="board-repos" aria-label="Repositories">
          <div class="toolbar" role="group" aria-label="Filter repositories">
            <label class="field field-search">
              <span class="sr-only">Find a repository</span>
              <input
                type="search"
                placeholder="Find a repository"
                value={query}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
            <label class="field">
              <span class="sr-only">Owner</span>
              <select value={owner} onChange={(event) => setOwner(event.currentTarget.value)}>
                <option value="">All owners</option>
                {owners.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label class="toggle">
              <input
                type="checkbox"
                checked={behindOnly}
                onChange={(event) => setBehindOnly(event.currentTarget.checked)}
              />
              Behind only
            </label>
            {hidden > 0 && (
              <label class="toggle">
                <input
                  type="checkbox"
                  checked={showInactive}
                  onChange={(event) => setShowInactive(event.currentTarget.checked)}
                />
                Show{" "}
                {plural(hidden, "fork or archived repository", "forks and archived repositories")}
              </label>
            )}
          </div>

          {focus && (
            <div class="focus-bar" role="status">
              <p>
                <strong>{focus.title}</strong>
                <span>
                  {focusCount === 0
                    ? "Every repository follows this practice or is exempt."
                    : `${plural(focusCount, "repository needs", "repositories need")} attention.`}
                </span>
              </p>
              <a href={paths.practice(focus.id)} onClick={linkHandler(paths.practice(focus.id))}>
                Open practice
              </a>
              <button type="button" class="link-button" onClick={() => setFocused(null)}>
                Show all repositories
              </button>
            </div>
          )}

          <Legend />

          {groups.length > 0 ? (
            <RepoList
              overview={overview}
              practices={practices}
              groups={groups}
              selected={selected}
              highlight={hovered ?? focus?.id ?? null}
            />
          ) : (
            !focus && (
              <p class="no-match">
                No repositories match these filters.{" "}
                <button
                  type="button"
                  class="link-button"
                  onClick={() => {
                    setOwner("");
                    setQuery("");
                    setBehindOnly(false);
                  }}
                >
                  Clear filters
                </button>
              </p>
            )
          )}
        </section>
      </div>

      {repo && (
        <RepoPanel
          owner={repo.owner}
          name={repo.name}
          overview={overview}
          onRefresh={onRefresh}
          refreshing={refreshing}
        />
      )}
    </>
  );
}
