// @vitest-environment happy-dom
import { createElement, render } from "preact";
import { describe, expect, it } from "vitest";
import { QueryStatus, type QueryStatusProps } from "@/ui/components/query-status";

const idle: QueryStatusProps["query"] = {
  isFetching: false,
  isPaused: false,
  failureCount: 0,
  failureReason: null,
};

function renderStatus(query: Partial<QueryStatusProps["query"]>, background?: boolean) {
  const container = document.createElement("div");
  render(
    createElement(QueryStatus, { query: { ...idle, ...query }, label: "Updating…", background }),
    container,
  );

  return container;
}

describe("QueryStatus", () => {
  it("shows the label while loading content for the first time", () => {
    expect(renderStatus({ isFetching: true }).textContent).toBe("Updating…");
  });

  it("renders nothing for a background refetch so content doesn't shift", () => {
    expect(renderStatus({ isFetching: true }, true).childElementCount).toBe(0);
  });

  it("still surfaces failures during a background refetch", () => {
    const container = renderStatus(
      { isFetching: true, failureCount: 1, failureReason: new Error("Server busy.") },
      true,
    );

    expect(container.textContent).toBe("Server busy. Retrying automatically…");
  });

  it("still surfaces a lost connection during a background refetch", () => {
    expect(renderStatus({ isPaused: true }, true).textContent).toBe("Waiting for a connection…");
  });
});
