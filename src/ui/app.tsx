import { useCallback, useEffect, useState } from "preact/hooks";
import type { OverviewResponse } from "../api/contract";
import { api, ApiError } from "./api";
import { plural, timeAgo } from "./format";
import { linkHandler, paths, useRoute, type Route } from "./router";
import { startTask } from "./tasks";
import { Overview } from "./views/overview";
import { PracticeEditor } from "./views/practice-editor";
import { Practices } from "./views/practices";

const POLL_MS = 3_000;

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
  onRefresh: () => Promise<void>;
  section: "repositories" | "practices";
}

interface AppProps {
  login: string;
}

function Masthead({ login, overview, onRefresh, section }: MastheadProps) {
  const [busy, setBusy] = useState(false);
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
      <div class="sweep" role="status">
        {overview &&
          (pending > 0 ? (
            <span class="sweep-running">
              Checking {plural(pending, "repository", "repositories")}…
            </span>
          ) : (
            <span>Checked {timeAgo(overview.sweep.lastCompletedAt)}</span>
          ))}
        <button
          type="button"
          class="button button-quiet button-small"
          disabled={busy || pending > 0 || !overview}
          onClick={() => {
            setBusy(true);
            startTask(onRefresh().finally(() => setBusy(false)));
          }}
        >
          Check all again
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
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api
        .overview()
        .then((value) => {
          setOverview(value);
          setError(null);

          return value;
        })
        .catch((cause: unknown) => {
          setError(
            cause instanceof ApiError
              ? cause.message
              : "Shipshape couldn't load your repositories.",
          );

          return null;
        }),
    [],
  );

  useEffect(() => {
    startTask(load());
  }, [load]);

  const pending = overview?.sweep.pending ?? 0;

  useEffect(() => {
    if (pending === 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      startTask(load());
    }, POLL_MS);

    return () => window.clearTimeout(timer);
  }, [overview, pending, load]);

  const refresh = useCallback(
    async (repo?: string) => {
      try {
        await api.refresh(repo);
      } catch (cause: unknown) {
        setError(cause instanceof ApiError ? cause.message : "Shipshape couldn't queue the check.");
      }

      await load();
    },
    [load],
  );

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
      <Masthead login={login} overview={overview} onRefresh={() => refresh()} section={section} />
      <main id="main" class={`page page-${route.view}`}>
        {error && (
          <p class="notice notice-error" role="alert">
            {error}{" "}
            <button
              type="button"
              class="link-button"
              onClick={() => {
                startTask(load());
              }}
            >
              Try again
            </button>
          </p>
        )}
        {!overview && !error && <p class="loading">Loading repositories…</p>}
        {overview && route.view === "overview" && (
          <Overview overview={overview} login={login} repo={route.repo} onRefresh={refresh} />
        )}
        {overview && route.view === "practices" && <Practices overview={overview} />}
        {overview && route.view === "practice" && (
          <PracticeEditor
            overview={overview}
            id={route.id}
            onSaved={() => {
              startTask(load());
            }}
          />
        )}
        {overview && route.view === "new-practice" && (
          <PracticeEditor
            overview={overview}
            id={null}
            onSaved={() => {
              startTask(load());
            }}
          />
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
