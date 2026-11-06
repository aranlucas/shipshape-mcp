import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { handleFixtureRequest } from "@/ui/dev/fixture-api";

const url = "/app/api/practices/husky-lint-staged";

const yaml = readFileSync(
  new URL("../../catalog-seed/practices/husky-lint-staged/practice.yml", import.meta.url),
  "utf8",
);

it("uses shipped definitions and restores them after editing an override", () => {
  const original = handleFixtureRequest("GET", url, "");
  expect(original.body).toMatchObject({ yaml });
  const edited = yaml.replace(/title:.*$/mu, "title: Edited title");
  expect(handleFixtureRequest("PUT", url, JSON.stringify({ yaml: edited })).status).toBe(200);
  expect(handleFixtureRequest("GET", url, "").body).toMatchObject({
    yaml: edited,
    practice: { title: "Edited title", origin: "override" },
  });
  expect(handleFixtureRequest("POST", `${url}/reset`, "").status).toBe(200);
  expect(handleFixtureRequest("GET", url, "").body).toMatchObject({
    yaml,
    practice: { origin: "built-in" },
  });
});

it("rejects unsupported practice checks using the actual practice schema", () => {
  const invalid = yaml.replace(/type: [^\n]+/u, "type: invented-check");
  expect(handleFixtureRequest("PUT", url, JSON.stringify({ yaml: invalid })).status).toBe(400);
});
