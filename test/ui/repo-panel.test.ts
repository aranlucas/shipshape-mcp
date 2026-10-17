// @vitest-environment happy-dom
import {
  focusManager,
  onlineManager,
  QueryClientProvider,
  type QueryClient,
} from "@tanstack/react-query";
import { createElement, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OverviewResponse, RepoDetailResponse, RepoSummary } from "@/api/contract";
import { api, ApiError } from "@/ui/api";
import { App } from "@/ui/app";
import { createQueryClient, overviewQuery, repoQuery } from "@/ui/queries";
import { navigate } from "@/ui/router";

function repository(name: string): RepoSummary {
  return {
    fullName: `aranlucas/${name}`,
    owner: "aranlucas",
    name,
    private: false,
    archived: false,
    fork: false,
    language: "TypeScript",
    defaultBranch: "main",
    pushedAt: null,
    url: `https://github.com/aranlucas/${name}`,
  };
}

const vienna = repository("vienna-travel");

const other = repository("other");

const practice = {
  id: "lint",
  title: "Lint configuration",
  summary: "Use the shared lint configuration.",
  kind: "files",
  valid: true,
  error: null,
  origin: "built-in",
  matchesBuiltIn: false,
} satisfies OverviewResponse["practices"][number];

const cell = {
  state: "pass",
  checkedAt: "2026-10-15T12:00:00Z",
  failing: 0,
  unknown: 0,
} satisfies OverviewResponse["results"][string][string];

function overview(pending = 1, checkedAt = cell.checkedAt): OverviewResponse {
  return {
    catalog: { repo: "aranlucas/practices", sha: "catalog-v1", loadedAt: null, disabled: [] },
    practices: [practice],
    repos: [vienna, other],
    results: { [vienna.fullName]: { lint: { ...cell, checkedAt } } },
    sweep: { pending, lastCompletedAt: null },
  };
}

function detail(
  repo = vienna,
  label = "Original check",
  checkedAt = cell.checkedAt,
): RepoDetailResponse {
  return {
    catalog: { sha: "catalog-v1", loadedAt: "2026-10-15T11:00:00Z" },
    repo,
    headSha: "a".repeat(40),
    practices: [
      {
        practice,
        result: { ...cell, checkedAt },
        headSha: "a".repeat(40),
        catalogSha: "catalog-v1",
        checks: [
          {
            type: "file-exists",
            label,
            state: "pass",
            path: "lint.json",
            expected: null,
            actual: null,
            detail: null,
          },
        ],
      },
    ],
  };
}

function deferred<T>() {
  let complete!: (value: T) => void;

  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });

  return { promise, resolve: complete };
}

let container: HTMLDivElement;

let client: QueryClient;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("reportError", vi.fn());
  client = createQueryClient();
  window.history.replaceState(null, "", "/app/repos/aranlucas/vienna-travel");
  container = document.createElement("div");
  document.body.replaceChildren(container);
});

afterEach(async () => {
  await act(() => render(null, container));
  client.clear();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mount() {
  await act(() => {
    render(
      createElement(QueryClientProvider, { client }, createElement(App, { login: "aranlucas" })),
      container,
    );
  });
  await flushQueries();
  await flushQueries();
}

async function flushQueries() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
}

async function poll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_000);
  });
  await act(() => Promise.resolve());
}

describe("repository panel during overview polling", () => {
  it("refreshes only the selected repository while preserving the view and other cached results", async () => {
    const nextDetail = deferred<RepoDetailResponse>();
    const initial = overview(0);
    initial.results[other.fullName] = { lint: cell };

    const overviewRequest = vi.spyOn(api, "overview").mockResolvedValue(initial);
    const otherDetail = detail(other, "Other check");
    client.setQueryData(repoQuery(other.owner, other.name).queryKey, otherDetail);

    const repoRequest = vi
      .spyOn(api, "repo")
      .mockResolvedValueOnce(detail())
      .mockReturnValue(nextDetail.promise);

    const check = vi.spyOn(api, "refresh");
    await mount();
    expect(container.querySelector(".masthead")?.textContent).not.toContain("Refresh");

    const section = container.querySelector<HTMLDetailsElement>(".panel-section details");
    const filter = container.querySelector<HTMLInputElement>("input[type='search']");

    const refresh = [...container.querySelectorAll<HTMLButtonElement>(".panel button")].find(
      (button) => button.textContent === "Refresh",
    );

    if (!section || !filter || !refresh) {
      throw new Error("Missing dashboard controls");
    }

    section.open = true;
    await act(() => {
      filter.value = "vienna";
      filter.dispatchEvent(new Event("input", { bubbles: true }));
      refresh.click();
    });
    await flushQueries();
    expect(overviewRequest).toHaveBeenCalledTimes(1);
    expect(repoRequest).toHaveBeenCalledTimes(2);
    expect(repoRequest).toHaveBeenLastCalledWith(
      vienna.owner,
      vienna.name,
      expect.any(AbortSignal),
    );
    expect(refresh.textContent).toBe("Refreshing…");
    expect(refresh.disabled).toBe(true);
    expect(container.textContent).toContain("Original check");
    expect(section.open).toBe(true);
    expect(filter.value).toBe("vienna");
    expect(check).not.toHaveBeenCalled();

    await act(() => {
      nextDetail.resolve(detail(vienna, "Updated check", "2026-10-15T13:00:00Z"));
    });
    await flushQueries();
    expect(container.textContent).toContain("Updated check");
    expect(container.querySelector(".panel-section details")).toBe(section);
    expect(section.open).toBe(true);
    expect(filter.value).toBe("vienna");
    expect(refresh.textContent).toBe("Refresh");
    expect(refresh.disabled).toBe(false);
    expect(client.getQueryData<OverviewResponse>(overviewQuery.queryKey)?.results).toEqual({
      [vienna.fullName]: { lint: { ...cell, checkedAt: "2026-10-15T13:00:00Z" } },
      [other.fullName]: { lint: cell },
    });
    expect(client.getQueryData(repoQuery(other.owner, other.name).queryKey)).toBe(otherDetail);
    await act(() => navigate("/app/repos/aranlucas/other"));
    await flushQueries();
    expect(container.textContent).toContain("Other check");
    expect(repoRequest).toHaveBeenCalledTimes(2);
  });

  it("keeps stale idle results until refresh across focus, reconnect, and panel navigation", async () => {
    const overviewRequest = vi.spyOn(api, "overview").mockResolvedValue(overview(0));
    const repoRequest = vi.spyOn(api, "repo").mockResolvedValue(detail());
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await act(() => navigate("/app"));
    await act(() => navigate("/app/repos/aranlucas/vienna-travel"));
    await flushQueries();
    expect(overviewRequest).toHaveBeenCalledTimes(1);
    expect(repoRequest).toHaveBeenCalledTimes(1);
  });

  it("does not keep polling details that are newer than the overview", async () => {
    const current = detail(vienna, "Latest check", "2026-10-15T13:00:00Z");
    vi.spyOn(api, "overview").mockResolvedValue(overview(0));
    const repoRequest = vi.spyOn(api, "repo").mockResolvedValue(current);
    await mount();
    await poll();
    await poll();
    expect(container.textContent).toContain("Latest check");
    expect(repoRequest).toHaveBeenCalledTimes(1);
  });

  it("does not keep polling a catalog that is newer than the overview", async () => {
    const previous = overview(0);
    previous.catalog.loadedAt = "2026-10-15T11:00:00Z";
    const current = detail();
    current.catalog = { sha: "catalog-v2", loadedAt: "2026-10-15T13:00:00Z" };
    vi.spyOn(api, "overview").mockResolvedValue(previous);
    const repoRequest = vi.spyOn(api, "repo").mockResolvedValue(current);
    await mount();
    await poll();
    await poll();
    expect(repoRequest).toHaveBeenCalledTimes(1);
  });

  it("reuses fresh checks when reopening the same repository", async () => {
    vi.spyOn(api, "overview").mockResolvedValue(overview(0));
    const repoRequest = vi.spyOn(api, "repo").mockResolvedValue(detail());
    await mount();
    await act(() => navigate("/app"));
    await act(() => navigate("/app/repos/aranlucas/vienna-travel"));
    await flushQueries();
    expect(container.textContent).toContain("Original check");
    expect(repoRequest).toHaveBeenCalledTimes(1);
  });

  it("starts polling after a refresh mutation and stops when the sweep completes", async () => {
    const refresh = vi.spyOn(api, "refresh").mockResolvedValue({ queued: 1 });

    const overviewRequest = vi
      .spyOn(api, "overview")
      .mockResolvedValueOnce(overview(0))
      .mockResolvedValueOnce(overview(1))
      .mockResolvedValue(overview(0, "2026-10-15T13:00:00Z"));

    vi.spyOn(api, "repo").mockResolvedValue(detail());
    await mount();
    await poll();
    expect(overviewRequest).toHaveBeenCalledTimes(1);

    await act(() => {
      const button = [...container.querySelectorAll(".panel button")].find(
        (item) => item.textContent === "Check again",
      );

      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("Missing Check again button");
      }

      button.click();
    });
    await flushQueries();
    await flushQueries();
    expect(refresh).toHaveBeenCalledWith(vienna.fullName);
    expect(overviewRequest).toHaveBeenCalledTimes(2);
    await poll();
    expect(overviewRequest).toHaveBeenCalledTimes(3);
    await poll();
    expect(overviewRequest).toHaveBeenCalledTimes(3);
  });

  it("displays a failed refresh mutation without discarding checks", async () => {
    vi.spyOn(api, "refresh").mockRejectedValue(new ApiError("Couldn't queue repository", 503));
    vi.spyOn(api, "overview").mockResolvedValue(overview(0));
    vi.spyOn(api, "repo").mockResolvedValue(detail());
    await mount();
    await act(() => {
      const button = [...container.querySelectorAll("button")].find(
        (item) => item.textContent === "Check all again",
      );

      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("Missing Check all again button");
      }

      button.click();
    });
    await flushQueries();
    expect(container.textContent).toContain("Couldn't queue repository");
    expect(container.textContent).toContain("Original check");
    expect(api.overview).toHaveBeenCalledTimes(1);
  });

  it("does not restart a slow detail request when unrelated sweep state changes", async () => {
    const request = deferred<RepoDetailResponse>();

    const overviewRequest = vi
      .spyOn(api, "overview")
      .mockResolvedValueOnce(overview(2))
      .mockImplementation(() => Promise.resolve(overview(1)));

    const repoRequest = vi.spyOn(api, "repo").mockReturnValue(request.promise);
    await mount();
    await poll();
    await poll();
    expect(overviewRequest).toHaveBeenCalledTimes(3);
    expect(repoRequest).toHaveBeenCalledTimes(1);

    await act(async () => {
      request.resolve(detail());
      await request.promise;
    });
    await flushQueries();
    expect(container.textContent).toContain("Original check");
  });

  it("lets a slow detail request finish while this repository's results keep changing", async () => {
    const request = deferred<RepoDetailResponse>();
    let revision = 0;
    vi.spyOn(api, "overview").mockImplementation(() =>
      Promise.resolve(overview(1, `2026-10-15T13:00:0${Math.min(revision++, 2)}Z`)),
    );

    const repoRequest = vi
      .spyOn(api, "repo")
      .mockReturnValueOnce(request.promise)
      .mockResolvedValue(detail(vienna, "Latest check", "2026-10-15T13:00:02Z"));

    await mount();
    const signal = repoRequest.mock.calls[0]?.[2];
    await poll();
    await poll();
    expect(signal?.aborted).toBe(false);
    expect(repoRequest).toHaveBeenCalledTimes(1);

    await act(async () => {
      request.resolve(detail());
      await request.promise;
    });
    await flushQueries();
    expect(container.textContent).toContain("Original check");
    await poll();
    expect(container.textContent).toContain("Latest check");
    expect(repoRequest).toHaveBeenCalledTimes(2);
    expect(client.getQueryCache().findAll({ queryKey: ["repos"] })).toHaveLength(1);
    await poll();
    expect(repoRequest).toHaveBeenCalledTimes(2);
  });

  it("keeps existing checks and expanded sections after a changed-result request fails", async () => {
    vi.spyOn(api, "overview")
      .mockResolvedValueOnce(overview())
      .mockResolvedValue(overview(0, "2026-10-15T13:00:00Z"));

    const repoRequest = vi
      .spyOn(api, "repo")
      .mockResolvedValueOnce(detail())
      .mockRejectedValue(new ApiError("Couldn't update checks", 503));

    await mount();
    const section = container.querySelector(".panel-section details");

    if (!(section instanceof HTMLDetailsElement)) {
      throw new Error("Missing practice section");
    }

    section.open = true;
    await poll();
    await poll();
    await flushQueries();
    expect(container.textContent).toContain("Couldn't update checks");
    expect(container.textContent).toContain("Original check");
    expect(container.querySelector(".panel-section details")).toBe(section);
    expect(section.open).toBe(true);

    repoRequest.mockResolvedValue(detail(vienna, "Recovered check"));
    expect(container.textContent).toContain("Retrying automatically…");
    await poll();
    await flushQueries();
    expect(container.textContent).toContain("Recovered check");
    expect(container.textContent).not.toContain("Couldn't update checks");
    expect(container.querySelector(".panel-section details")).toBe(section);
    expect(section.open).toBe(true);
  });

  it("retries overview failures without restarting the panel request", async () => {
    const pending = deferred<RepoDetailResponse>();

    const overviewRequest = vi
      .spyOn(api, "overview")
      .mockResolvedValueOnce(overview())
      .mockRejectedValueOnce(new ApiError("Overview temporarily unavailable", 503))
      .mockResolvedValue(overview(0));

    const repoRequest = vi.spyOn(api, "repo").mockReturnValue(pending.promise);
    await mount();
    await poll();
    await flushQueries();
    expect(container.textContent).toContain("Retrying automatically…");
    expect(container.textContent).toContain("Loading checks…");
    await poll();
    await flushQueries();
    expect(overviewRequest).toHaveBeenCalledTimes(3);
    expect(repoRequest).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Retrying automatically…");
    await act(async () => {
      pending.resolve(detail());
      await pending.promise;
    });
    await flushQueries();
    expect(container.textContent).toContain("Original check");
    expect(container.textContent).not.toContain("Loading checks…");
  });

  it("recovers the first load automatically after repeated failures", async () => {
    vi.spyOn(api, "overview")
      .mockRejectedValueOnce(new ApiError("Temporary failure", 503))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(overview(0));
    vi.spyOn(api, "repo").mockResolvedValue(detail());
    await mount();
    expect(container.textContent).toContain("Retrying automatically…");
    await poll();
    await poll();
    await poll();
    await flushQueries();
    expect(container.textContent).toContain("Original check");
    expect(container.textContent).not.toContain("Retrying automatically…");
  });

  it("does not retry permanent detail failures", async () => {
    vi.spyOn(api, "overview").mockResolvedValue(overview(0));

    const repoRequest = vi
      .spyOn(api, "repo")
      .mockRejectedValue(new ApiError("Repository missing", 404));

    await mount();
    await poll();
    await poll();
    expect(container.textContent).toContain("Repository missing");
    expect(repoRequest).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".panel [role='status']")).toBeNull();
  });

  it("shows individual retries and clears them even when checkedAt is unchanged", async () => {
    const retrying = overview(0);
    retrying.results[vienna.fullName].lint = {
      ...cell,
      state: "unknown",
      unknown: 1,
      retrying: true,
    };
    const pendingDetail = detail();
    pendingDetail.practices[0].result = { ...retrying.results[vienna.fullName].lint };
    vi.spyOn(api, "overview").mockResolvedValueOnce(retrying).mockResolvedValue(overview(0));
    vi.spyOn(api, "repo").mockResolvedValueOnce(pendingDetail).mockResolvedValue(detail());
    await mount();
    expect(container.querySelectorAll(".mark-loading")).toHaveLength(2);
    expect(container.textContent).toContain("Retrying unavailable checks…");
    await poll();
    await poll();
    await flushQueries();
    expect(container.querySelector(".mark-loading")).toBeNull();
    expect(container.textContent).not.toContain("Retrying unavailable checks…");
    expect(container.textContent).toContain("Original check");
  });

  it("catches up after a slow background request and stops polling once results match", async () => {
    const pending = deferred<RepoDetailResponse>();
    let revision = 0;
    vi.spyOn(api, "overview").mockImplementation(() =>
      Promise.resolve(overview(1, `2026-10-15T13:00:0${Math.min(revision++, 2)}Z`)),
    );

    const repoRequest = vi
      .spyOn(api, "repo")
      .mockResolvedValueOnce(detail())
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(detail(vienna, "Latest check", "2026-10-15T13:00:02Z"));

    await mount();
    await poll();
    const signal = repoRequest.mock.calls[1]?.[2];
    await poll();
    await poll();
    expect(signal?.aborted).toBe(false);
    expect(repoRequest).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Original check");

    await act(async () => {
      pending.resolve(detail(vienna, "Intermediate check"));
      await pending.promise;
    });
    await flushQueries();
    await poll();
    expect(repoRequest).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("Latest check");
    expect(client.getQueryCache().findAll({ queryKey: ["repos"] })).toHaveLength(1);
    await poll();
    expect(repoRequest).toHaveBeenCalledTimes(3);
  });

  it("stops detail polling when the panel closes", async () => {
    const pending = deferred<RepoDetailResponse>();
    vi.spyOn(api, "overview")
      .mockResolvedValueOnce(overview())
      .mockResolvedValue(overview(0, "2026-10-15T13:00:00Z"));
    const repoRequest = vi.spyOn(api, "repo").mockReturnValue(pending.promise);
    await mount();
    await poll();
    await act(() => navigate("/app"));

    await act(async () => {
      pending.resolve(detail());
      await pending.promise;
    });
    await flushQueries();
    await poll();
    expect(container.querySelector(".panel")).toBeNull();
    expect(repoRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps checks and expanded sections visible while fetching changed results", async () => {
    const updated = deferred<RepoDetailResponse>();
    vi.spyOn(api, "overview")
      .mockResolvedValueOnce(overview())
      .mockResolvedValue(overview(0, "2026-10-15T13:00:00Z"));
    vi.spyOn(api, "repo").mockResolvedValueOnce(detail()).mockReturnValue(updated.promise);
    await mount();
    const section = container.querySelector(".panel-section details");
    expect(section).toBeInstanceOf(HTMLDetailsElement);

    if (!(section instanceof HTMLDetailsElement)) {
      throw new Error("Missing practice section");
    }

    section.open = true;

    await poll();
    await poll();
    expect(container.textContent).toContain("Original check");
    expect(container.textContent).not.toContain("Loading checks…");
    expect(section.isConnected).toBe(true);
    expect(section.open).toBe(true);

    await act(async () => {
      updated.resolve(detail(vienna, "Updated check"));
      await updated.promise;
    });
    await flushQueries();
    expect(container.textContent).toContain("Updated check");
    expect(container.querySelector(".panel-section details")).toBe(section);
    expect(section.open).toBe(true);
  });

  it("reloads details after a catalog revision even if result timestamps are unchanged", async () => {
    const next = overview(0);
    next.catalog.sha = "catalog-v2";
    vi.spyOn(api, "overview").mockResolvedValueOnce(overview()).mockResolvedValue(next);
    const repoRequest = vi.spyOn(api, "repo").mockResolvedValue(detail());
    await mount();
    await poll();
    await poll();
    expect(repoRequest).toHaveBeenCalledTimes(2);
  });

  it("stops polling a new catalog once unevaluated details catch up", async () => {
    const initial = overview();
    initial.results = {};

    const next = {
      ...initial,
      catalog: { ...initial.catalog, sha: "catalog-v2" },
      sweep: { pending: 0, lastCompletedAt: null },
    };

    const before = detail();
    before.practices[0].result.checkedAt = null;
    const after = { ...before, catalog: { ...before.catalog, sha: "catalog-v2" } };
    vi.spyOn(api, "overview").mockResolvedValueOnce(initial).mockResolvedValue(next);

    const repoRequest = vi
      .spyOn(api, "repo")
      .mockResolvedValueOnce(before)
      .mockResolvedValue(after);

    await mount();
    await poll();
    await poll();
    expect(repoRequest).toHaveBeenCalledTimes(2);
    await poll();
    expect(repoRequest).toHaveBeenCalledTimes(2);
  });

  it("hides the previous repository's checks and ignores its late response after navigation", async () => {
    const pendingVienna = deferred<RepoDetailResponse>();
    const pendingOther = deferred<RepoDetailResponse>();
    vi.spyOn(api, "overview")
      .mockResolvedValueOnce(overview())
      .mockResolvedValue(overview(0, "2026-10-15T13:00:00Z"));
    vi.spyOn(api, "repo")
      .mockResolvedValueOnce(detail())
      .mockReturnValueOnce(pendingVienna.promise)
      .mockReturnValueOnce(pendingOther.promise);
    await mount();
    await poll();
    await poll();
    await act(() => navigate("/app/repos/aranlucas/other"));
    expect(container.textContent).not.toContain("Original check");
    expect(container.textContent).toContain("Loading checks…");

    await act(async () => {
      pendingVienna.resolve(detail(vienna, "Late Vienna check"));
      await pendingVienna.promise;
    });
    await flushQueries();
    expect(container.textContent).not.toContain("Late Vienna check");
    await act(async () => {
      pendingOther.resolve(detail(other, "Other check"));
      await pendingOther.promise;
    });
    await flushQueries();
    expect(container.textContent).toContain("Other check");
    expect(container.textContent).not.toContain("Late Vienna check");
  });
});
