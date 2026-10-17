import { useIsFetching, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "preact/hooks";
import type { OverviewResponse } from "../api/contract";
import { ApiError } from "./api";
import { QueryStatus } from "./components/query-status";
import { plural, timeAgo } from "./format";
import { refreshMutationOptions } from "./mutations";
import { overviewQuery, queryKeys } from "./queries";
import { linkHandler, paths, useRoute, type Route } from "./router";
import { startTask } from "./tasks";
import { Overview } from "./views/overview";
import { PracticeEditor } from "./views/practice-editor";
import { Practices } from "./views/practices";

const TITLES = {
  overview: "Repositories",
  practices: "Practices",
  practice: "Practice",
  "new-practice": "New practice",
  missing: "Not found",
} satisfies Record<Route["view"], string>;

interface MastheadProps {
  login: string;
  overview: OverviewResponse | null;
  onRefresh: () => void;
  refreshing: boolean;
  onReload: () => void;
  reloading: boolean;
  section: "repositories" | "practices";
}

interface AppProps {
  login: string;
}

function Masthead({
  login,
  overview,
  onRefresh,
  refreshing,
  onReload,
  reloading,
  section,
}: MastheadProps) {
  const pending = overview?.sweep.pending ?? 0;

  return (
    <header class="masthead">
      <a class="wordmark" href={paths.overview} onClick={linkHandler(paths.overview)}>
        Shipshape
      </a>
      <nav class="primary-nav" aria-label="Sections">
        <a
          href={paths.overview}
          onClick={linkHandler(paths.overview)}
          aria-current={section === "repositories" ? "page" : undefined}
        >
          Repositories
        </a>
        <a
          href={paths.practices}
          onClick={linkHandler(paths.practices)}
          aria-current={section === "practices" ? "page" : undefined}
        >
          Practices
        </a>
      </nav>
      <div class="sweep">
        <span role="status">
          {overview &&
            (pending > 0 ? (
              <span class="sweep-running">Checking… {plural(pending, "evaluation")} remaining</span>
            ) : (
              <span>
                {overview.sweep.lastCompletedAt
                  ? `Checked ${timeAgo(overview.sweep.lastCompletedAt)}`
                  : "Not checked yet"}
              </span>
            ))}
        </span>
        <button
          type="button"
          class="button button-quiet button-small"
          disabled={reloading}
          onClick={onReload}
          title="Load the latest stored results"
        >
          {reloading ? "Refreshing…" : "Refresh"}
        </button>
        <button
          type="button"
          class="button button-quiet button-small"
          disabled={refreshing || pending > 0 || !overview}
          onClick={onRefresh}
        >
          {overview?.repos.length === 0 ? "Find my repositories" : "Check all again"}
        </button>
      </div>
      <div class="account">
        <span>@{login}</span>
        <form method="post" action="/app/logout">
          <button type="submit" class="link-button">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}

export function App({ login }: AppProps) {
  const route = useRoute();
  const client = useQueryClient();
  const query = useQuery(overviewQuery);
  const overview = query.data ?? null;

  const reloading =
    useIsFetching({
      predicate: (entry) =>
        entry.queryKey[0] === queryKeys.overview[0] || entry.queryKey[0] === queryKeys.repos[0],
    }) > 0;

  const refreshMutation = useMutation(refreshMutationOptions(client));

  const cause = refreshMutation.error ?? query.error;

  const error = cause
    ? cause instanceof ApiError
      ? cause.message
      : refreshMutation.error
        ? "Shipshape couldn't queue the check."
        : "Shipshape couldn't load your repositories."
    : null;

  useEffect(() => {
    document.title = `${TITLES[route.view]} | Shipshape`;
  }, [route.view]);

  const section =
    route.view === "overview" || route.view === "missing" ? "repositories" : "practices";

  return (
    <>
      <a class="skip" href="#main">
        Skip to content
      </a>
      <Masthead
        login={login}
        overview={overview}
        onRefresh={() => refreshMutation.mutate()}
        refreshing={refreshMutation.isPending}
        onReload={() =>
          startTask(
            Promise.all([
              client.invalidateQueries({ queryKey: queryKeys.overview }),
              client.invalidateQueries({ queryKey: queryKeys.repos }),
            ]),
          )
        }
        reloading={reloading}
        section={section}
      />
      <main id="main" class={`page page-${route.view}`}>
        {error && (
          <p class="notice notice-error" role="alert">
            {error}{" "}
            <button
              type="button"
              class="link-button"
              onClick={() => {
                refreshMutation.reset();
                startTask(query.refetch());
              }}
            >
              Try again
            </button>
          </p>
        )}
        <QueryStatus
          query={query}
          background={overview !== null}
          label={overview ? "Updating repositories…" : "Loading repositories…"}
        />
        {overview && route.view === "overview" && (
          <Overview
            overview={overview}
            login={login}
            repo={route.repo}
            onRefresh={refreshMutation.mutate}
            refreshing={refreshMutation.isPending}
          />
        )}
        {overview && route.view === "practices" && <Practices overview={overview} />}
        {overview && route.view === "practice" && (
          <PracticeEditor overview={overview} id={route.id} />
        )}
        {overview && route.view === "new-practice" && (
          <PracticeEditor overview={overview} id={null} />
        )}
        {route.view === "missing" && (
          <section class="empty-state">
            <h1>There's nothing at this address</h1>
            <p>
              <a href={paths.overview} onClick={linkHandler(paths.overview)}>
                Go to your repositories
              </a>
            </p>
          </section>
        )}
      </main>
    </>
  );
}
