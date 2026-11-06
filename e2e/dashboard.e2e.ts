import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// Uses the existing dashboard fixture API; it never connects to production GitHub.
test("create, reload, edit and delete a practice with a commented YAML ID", async ({
  app,
  browser,
  screen,
}) => {
  const yaml = `version: 1
id: audit-example # valid YAML comment
title: Audit example
summary: Verify the practice lifecycle
kind: files
checks:
  - type: file-exists
    path: README.md
`;

  await app.open("/app/practices/new");
  await screen.getByRole("textbox", "practice.yml").fill(yaml);
  await screen.getByRole("button", "Add practice").click();
  await expect(browser).toHaveURL(/\/app\/practices\/audit-example$/);
  await expect(screen.getByRole("heading", "Audit example", { exact: true })).toBeVisible();

  await app.open("/app/practices/audit-example");
  await expect(screen.getByRole("textbox", "practice.yml")).toHaveValue(yaml);
  await screen.getByRole("tab", "instructions.md").click();
  await screen.getByRole("textbox", "instructions.md").fill("Keep the README current.");
  await screen.getByRole("button", "Save practice").click();
  await expect(browser.locator(".notice-ok")).toContainText("Saved to");
  await app.open("/app/practices/audit-example");
  await screen.getByRole("tab", "instructions.md").click();
  await expect(screen.getByRole("textbox", "instructions.md")).toHaveValue(
    "Keep the README current.",
  );

  await screen.getByRole("button", "Delete practice", { exact: true }).click();
  await screen.getByRole("button", "Delete practice", { exact: true }).click();
  await expect(browser).toHaveURL(/\/app\/practices$/);
  await expect(screen.getByRole("link", "Audit example", { exact: true })).not.toBeVisible();
  await app.open("/app/practices/audit-example");
  await expect(screen.getByRole("heading", "Practice not found")).toBeVisible();
});
