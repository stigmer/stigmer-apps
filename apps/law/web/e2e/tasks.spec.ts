/**
 * The task working-day flow on the rebuilt model: create a task against
 * a real matter by typing its FILE number, watch the derived facts
 * arrive (file number on the row; overdue — the record model), drive
 * the lifecycle through updateStatus, converse in comments, and verify
 * the "My Tasks" contract keeps other people's tasks out of my default
 * view.
 */

import { expect, test, type Page } from "@playwright/test";
import { ASHA, RAVI, SEED_CASE } from "./fixtures.js";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
}

test("create → detail → status → comment → my list, with derived facts throughout", async ({ page }) => {
  await signIn(page, ASHA.email, ASHA.password);

  // Standalone creation: the lawyer types the firm's file number.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Tasks" }).click();
  await page.getByRole("link", { name: "New task" }).click();
  await page.getByLabel("File number").fill(SEED_CASE.fileNumber);
  await page.getByLabel("Title").fill("Draft rejoinder");
  await page.getByLabel("Assign to").selectOption({ label: ASHA.name });
  // A past due date: the server must derive overdue (Asia/Kolkata).
  await page.getByLabel(/Due date/).fill("2020-01-01");
  await page.getByRole("button", { name: "Create task" }).click();

  // Detail: derived file number, Open state, overdue badge.
  await expect(page.getByRole("heading", { name: "Draft rejoinder" })).toBeVisible();
  await expect(page.getByRole("link", { name: SEED_CASE.fileNumber })).toBeVisible();
  await expect(page.getByText("Overdue")).toBeVisible();
  await expect(page.getByLabel("Status")).toHaveValue("1"); // OPEN

  // Lifecycle via the ONLY write path.
  await page.getByLabel("Status").selectOption({ label: "In progress" });
  await expect(page.getByLabel("Status")).toHaveValue("2");

  // Conversation, oldest first, author from the envelope.
  await page.getByLabel("Add a comment").fill("Filed at the registry this morning.");
  await page.getByRole("button", { name: "Post comment" }).click();
  await expect(page.getByText("Filed at the registry this morning.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Comments" }).getByText(ASHA.name)).toBeVisible();

  // My list: the task at a glance — file number, overdue, state.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Tasks" }).click();
  const row = page.getByRole("link", { name: /Draft rejoinder/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText(SEED_CASE.fileNumber);
  await expect(row).toContainText("Overdue");
  await expect(row).toContainText("In progress");
});

test("'My Tasks' is the caller's view: a colleague's task stays out of my default list", async ({ page }) => {
  await signIn(page, ASHA.email, ASHA.password);

  // Asha creates a task for Ravi.
  await page.goto("/tasks/new");
  await page.getByLabel("File number").fill(SEED_CASE.fileNumber);
  await page.getByLabel("Title").fill("Serve notice to respondents");
  await page.getByLabel("Assign to").selectOption({ label: RAVI.name });
  await page.getByRole("button", { name: "Create task" }).click();
  await expect(page.getByRole("heading", { name: "Serve notice to respondents" })).toBeVisible();

  // Not in Asha's default list (the contract's default is HER assignments) …
  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Serve notice to respondents/ })).toHaveCount(0);

  // … but visible through the explicit assignee filter.
  await page.getByLabel("Assigned to").selectOption({ label: RAVI.name });
  await expect(page.getByRole("link", { name: /Serve notice to respondents/ })).toBeVisible();
});
