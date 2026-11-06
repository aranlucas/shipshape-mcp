import { expect, it } from "vitest";
import { parseRoute, paths } from "@/dashboard-routes";

it("recognizes the dashboard's repository and editor links", () => {
  expect(parseRoute(paths.repo("octo/a b"))).toEqual({
    view: "overview",
    repo: { owner: "octo", name: "a b" },
  });
  expect(parseRoute(paths.practice("lint"))).toEqual({ view: "practice", id: "lint" });
  expect(parseRoute(paths.newPractice)).toEqual({ view: "new-practice" });
  expect(parseRoute(paths.practices)).toEqual({ view: "practices" });
  expect(parseRoute(paths.overview)).toEqual({ view: "overview", repo: null });
});

it("rejects pages outside the dashboard and unknown page shapes", () => {
  expect(parseRoute("/application")).toEqual({ view: "missing" });
  expect(parseRoute("/app/repos/octo")).toEqual({ view: "missing" });
  expect(parseRoute("/app/practices/a/extra")).toEqual({ view: "missing" });
});
