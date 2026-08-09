/**
 * The notifications working-day flow (T04b.4 gate; FR-NOTIF-002/004):
 * a task assignment lands in the assignee's inbox, the badge carries the
 * server-derived unread count, tapping marks read AND deep-links to the
 * task, and mark-all-read clears the rest.
 *
 * Assertions stay scoped to THIS test's own notifications (unique task
 * titles): the suite runs in parallel against one backend, so global
 * counts belong to nobody.
 */

import { expect, test, type Page } from "@playwright/test";
import { ASHA, RAVI, SEED_CASE } from "./fixtures.js";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /Welcome,/ })).toBeVisible();
}

async function assignTaskToRavi(page: Page, title: string) {
  await page.goto("/tasks/new");
  await page.getByLabel("Case number").fill(SEED_CASE.caseNumber);
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Assign to").selectOption({ label: RAVI.name });
  await page.getByRole("button", { name: "Create task" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
}

test("assignment → badge → tap marks read and deep-links → mark all read", async ({ page }) => {
  const first = `Review discovery bundle ${Date.now()}`;
  const second = `Summon witness list ${Date.now()}`;

  await signIn(page, ASHA.email, ASHA.password);
  await assignTaskToRavi(page, first);
  await assignTaskToRavi(page, second);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  // The assignee's side.
  await signIn(page, RAVI.email, RAVI.password);

  // The badge is the server's derived count — present and numbered.
  const inboxLink = page.getByRole("link", { name: /^Inbox, \d+ unread$/ });
  await expect(inboxLink).toBeVisible();
  await inboxLink.click();

  // Both notifications, pre-composed by the producer, marked New.
  // exact: the producer's title ("New task assigned to you") also
  // contains the word — only the badge is the exact string "New".
  const firstItem = page.getByRole("listitem").filter({ hasText: first });
  const secondItem = page.getByRole("listitem").filter({ hasText: second });
  await expect(firstItem.getByText("New", { exact: true })).toBeVisible();
  await expect(secondItem.getByText("New", { exact: true })).toBeVisible();

  // Tap = mark read + deep-link to the task itself.
  await firstItem.getByRole("button").click();
  await expect(page.getByRole("heading", { name: first })).toBeVisible();
  await expect(page).toHaveURL(/\/tasks\/task_/);

  // Back in the inbox: the opened one is no longer New, the other still is.
  await page.getByRole("link", { name: /^Inbox/ }).click();
  await expect(firstItem.getByText("New", { exact: true })).toHaveCount(0);
  await expect(secondItem.getByText("New", { exact: true })).toBeVisible();

  // Mark all read clears the rest.
  await page.getByRole("button", { name: "Mark all as read" }).click();
  await expect(secondItem.getByText("New", { exact: true })).toHaveCount(0);
});

test("profile shows the read-only identity and signs out", async ({ page }) => {
  await signIn(page, RAVI.email, RAVI.password);

  await page.getByRole("banner").getByRole("link", { name: RAVI.name }).click();
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: RAVI.email })).toBeVisible();
  await expect(page.getByText(/ask your administrator/i)).toBeVisible();

  await page.getByRole("region", { name: "Profile" }).getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
});
