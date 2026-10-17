// @vitest-environment happy-dom
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createElement, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogWriteResponse } from "@/api/contract";
import { api, ApiError } from "@/ui/api";
import { App } from "@/ui/app";
import { createStore, overview, practiceDetail } from "@/ui/dev/fixtures";
import { createQueryClient, practiceQuery } from "@/ui/queries";
import { navigate } from "@/ui/router";

const PRACTICE_ID = "husky-lint-staged";

let client: QueryClient;

let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("reportError", vi.fn());
  client = createQueryClient();
  container = document.createElement("div");
  document.body.replaceChildren(container);
  window.history.replaceState(null, "", `/app/practices/${PRACTICE_ID}`);
  const store = createStore();
  vi.spyOn(api, "overview").mockImplementation(() => Promise.resolve(overview(store)));
  vi.spyOn(api, "practice").mockImplementation((id) => {
    const detail = practiceDetail(store, id);

    if (!detail) {
      throw new Error(`Missing fixture practice ${id}`);
    }

    return Promise.resolve(structuredClone(detail));
  });
});

afterEach(async () => {
  await act(() => render(null, container));
  client.clear();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function flushQueries() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
}

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

function yamlArea(): HTMLTextAreaElement {
  const area = container.querySelector("textarea");

  if (!(area instanceof HTMLTextAreaElement)) {
    throw new Error("Missing practice YAML editor");
  }

  return area;
}

async function editYaml(value: string) {
  await act(() => {
    const area = yamlArea();
    area.value = value;
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickButton(label: string) {
  await act(() => {
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === label,
    );

    if (!button) {
      throw new Error(`Missing button ${label}`);
    }

    button.click();
  });
  await flushQueries();
  await flushQueries();
}

describe("practice editor queries and mutations", () => {
  it("does not redirect back to a new practice after leaving a pending save", async () => {
    window.history.replaceState(null, "", "/app/practices/new");
    let complete!: (value: CatalogWriteResponse) => void;

    const saved = new Promise<CatalogWriteResponse>((resolve) => {
      complete = resolve;
    });

    vi.spyOn(api, "savePractice").mockReturnValue(saved);
    client.setQueryData(["unrelated"], { value: "unaffected" });
    await mount();
    await editYaml("id: new-practice\n");
    await clickButton("Add practice");
    await act(() => navigate("/app"));

    await act(async () => {
      complete({ catalogSha: "b".repeat(40) });
      await saved;
    });
    await flushQueries();
    expect(window.location.pathname).toBe("/app");
    expect(api.overview).toHaveBeenCalledTimes(2);
    expect(client.getQueryState(["unrelated"])?.isInvalidated).toBe(false);
  });

  it("invalidates a completed delete without redirecting after leaving the editor", async () => {
    let complete!: (value: CatalogWriteResponse) => void;

    const removed = new Promise<CatalogWriteResponse>((resolve) => {
      complete = resolve;
    });

    vi.spyOn(api, "deletePractice").mockReturnValue(removed);
    await mount();
    await clickButton("Turn off");
    await clickButton("Turn off");
    await act(() => navigate("/app"));

    await act(async () => {
      complete({ catalogSha: "b".repeat(40) });
      await removed;
    });
    await flushQueries();
    expect(window.location.pathname).toBe("/app");
    expect(api.overview).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(practiceQuery(PRACTICE_ID).queryKey)).toBeUndefined();
  });

  it("creates a practice without fetching a draft for the new-practice route", async () => {
    window.history.replaceState(null, "", "/app/practices/new");

    const save = vi.spyOn(api, "savePractice").mockImplementation((id, body) => {
      const previous = practiceDetail(createStore(), PRACTICE_ID);

      if (!previous) {
        throw new Error("Missing fixture practice");
      }

      vi.mocked(api.practice).mockResolvedValue({
        ...previous,
        ...body,
        practice: { ...previous.practice, id },
      });

      return Promise.resolve({ catalogSha: "b".repeat(40) });
    });

    await mount();
    expect(api.practice).not.toHaveBeenCalled();
    await editYaml("id: new-practice\n");
    await clickButton("Add practice");
    expect(save).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/app/practices/new-practice");
    expect(yamlArea().value).toBe("id: new-practice\n");
  });

  it("preserves an unsaved draft when the cached practice refetches", async () => {
    await mount();
    const draft = `${yamlArea().value}\n# Unsaved local edit\n`;
    await editYaml(draft);
    await act(async () => {
      await client.invalidateQueries({ queryKey: practiceQuery(PRACTICE_ID).queryKey });
    });
    await flushQueries();
    expect(api.practice).toHaveBeenCalledTimes(2);
    expect(yamlArea().value).toBe(draft);
  });

  it("loads a different practice's draft after navigation", async () => {
    await mount();
    await editYaml("id: local-draft");
    await act(() => navigate("/app/practices/oxforge-lint-format"));
    await flushQueries();
    expect(yamlArea().value).toContain("id: oxforge-lint-format");
    expect(yamlArea().value).not.toContain("local-draft");
  });

  it("saves through a mutation and refetches the overview and practice", async () => {
    const save = vi.spyOn(api, "savePractice").mockImplementation((id, body) => {
      const previous = practiceDetail(createStore(), id);

      if (!previous) {
        throw new Error(`Missing fixture practice ${id}`);
      }

      vi.mocked(api.practice).mockResolvedValue({ ...previous, ...body });

      return Promise.resolve({ catalogSha: "b".repeat(40) });
    });

    await mount();
    const yaml = `${yamlArea().value}\n# Saved edit\n`;
    await editYaml(yaml);
    await clickButton("Save practice");
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[1].yaml).toBe(yaml);
    expect(api.overview).toHaveBeenCalledTimes(2);
    expect(api.practice).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Saved to aranlucas/practices");
    expect(yamlArea().value).toBe(yaml);
  });

  it("keeps the draft and displays validation issues when a save fails", async () => {
    vi.spyOn(api, "savePractice").mockRejectedValue(
      new ApiError("Practice is invalid", 400, [
        { path: "checks.0.type", message: "Unknown check type" },
      ]),
    );
    await mount();
    await editYaml("id: invalid-draft");
    await clickButton("Save practice");
    expect(yamlArea().value).toBe("id: invalid-draft");
    expect(container.textContent).toContain("Practice is invalid");
    expect(container.textContent).toContain("checks.0.type");
    expect(container.textContent).toContain("Unknown check type");
    expect(api.overview).toHaveBeenCalledTimes(1);
  });

  it("deletes through a mutation and removes the deleted practice from the cache", async () => {
    const remove = vi
      .spyOn(api, "deletePractice")
      .mockResolvedValue({ catalogSha: "c".repeat(40) });

    await mount();
    await clickButton("Turn off");
    expect(remove).not.toHaveBeenCalled();
    await clickButton("Turn off");
    expect(remove).toHaveBeenCalledWith(PRACTICE_ID);
    expect(window.location.pathname).toBe("/app/practices");
    expect(client.getQueryData(practiceQuery(PRACTICE_ID).queryKey)).toBeUndefined();
    expect(api.overview).toHaveBeenCalledTimes(2);
    expect(api.practice).toHaveBeenCalledTimes(1);
  });

  it("resets an edited built-in after confirmation and reloads its definition", async () => {
    const reset = vi.spyOn(api, "resetPractice").mockResolvedValue({ catalogSha: "d".repeat(40) });

    await mount();
    await clickButton("Reset to built-in");
    expect(reset).not.toHaveBeenCalled();
    await clickButton("Reset to built-in");
    await flushQueries();

    expect(reset).toHaveBeenCalledWith(PRACTICE_ID);
    expect(window.location.pathname).toBe(`/app/practices/${PRACTICE_ID}`);
    expect(api.practice).toHaveBeenCalledTimes(2);
  });
});
