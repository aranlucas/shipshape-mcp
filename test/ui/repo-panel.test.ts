// @vitest-environment happy-dom
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createElement, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OverviewResponse, RepoDetailResponse, RepoSummary } from "@/api/contract";
import { api, ApiError } from "@/ui/api";
import { App } from "@/ui/app";
import { createQueryClient } from "@/ui/queries";
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
} satisfies OverviewResponse["practices"][number];

const cell = {
  state: "pass",
  checkedAt: "2026-10-15T12:00:00Z",
  failing: 0,
  unknown: 0,
} satisfies OverviewResponse["results"][string][string];

function overview(pending = 1, checkedAt = cell.checkedAt): OverviewResponse {
  return {
    catalog: { repo: "aranlucas/practices", sha: "catalog-v1", loadedAt: null },
    practices: [practice],
    repos: [vienna, other],
    results: { [vienna.fullName]: { lint: { ...cell, checkedAt } } },
    sweep: { pending, lastCompletedAt: null },
  };
}

function detail(repo = vienna, label = "Original check"): RepoDetailResponse {
  return {
    repo,
    headSha: "a".repeat(40),
    practices: [
      {
        practice,
        result: cell,
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
