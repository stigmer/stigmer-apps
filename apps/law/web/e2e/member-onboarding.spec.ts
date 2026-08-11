/**
 * The onboarding journey (DD-003 D4): the managing partner adds a
 * member in-product and hands over the shown-once activation code; the
 * member activates, signs in, and gets a role-appropriate app — a
 * clerk's app carries no Money surface and a read-only firm screen.
 * One arc, one browser, both sides of the hand-over.
 */

import { expect, test, type Page } from "@playwright/test";
import { ASHA } from "./fixtures.js";

/** Onboarded during this journey — fictional by decree, unique per run
 * so re-running against a long-lived dev server never collides. */
const KIRAN = {
  name: "Kiran Kumar",
  email: `kiran+${Date.now()}@acme.example`,
  password: "kirans-own-sensible-passphrase",
};

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
}

test("managing partner onboards a clerk; the clerk activates and sees a clerk's app", async ({
  page,
}) => {
  // ── The managing partner's half: account + role + code.
  await signIn(page, ASHA.email, ASHA.password);
  await page.goto("/members");
  await page.getByRole("button", { name: "Add member" }).click();
  await page.getByLabel("Name").fill(KIRAN.name);
  await page.getByLabel("Email").fill(KIRAN.email);
  await page.getByLabel("Role", { exact: true }).selectOption({ label: "Clerk" });
  await page.getByRole("button", { name: "Add member and get code" }).click();

  const card = page.getByRole("status", { name: "Activation code issued" });
  await expect(card).toContainText("will not be shown again");
  const code = (await card.locator("code").textContent()) ?? "";
  expect(code).toMatch(/^act_/);
  await signOut(page);

  // ── The clerk's half: the hand-over target.
  await page.goto("/activate");
  await page.getByLabel("Activation code").fill(code);
  await page.getByLabel("Choose a password").fill(KIRAN.password);
  await page.getByLabel("Repeat the password").fill(KIRAN.password);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByText("Your password is set.")).toBeVisible();
  await page.getByRole("status").getByRole("link", { name: "Sign in" }).click();

  await signIn(page, KIRAN.email, KIRAN.password);
  // Role-appropriate app: clerks have no Money surface (FR-AUTHZ-004)...
  await expect(page.getByRole("link", { name: "Money" })).toHaveCount(0);
  // ...and the firm screen is the read-only roster, no administration —
  // with the clerk listed under their own role group.
  await page.goto("/members");
  await expect(
    page.getByRole("region", { name: "Clerk" }).getByText(KIRAN.name),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Add member" })).toHaveCount(0);

  // The code is spent: a second activation with it answers the uniform
  // failure, verbatim.
  await signOut(page);
  await page.goto("/activate");
  await page.getByLabel("Activation code").fill(code);
  await page.getByLabel("Choose a password").fill("someone-elses-attempt");
  await page.getByLabel("Repeat the password").fill("someone-elses-attempt");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByRole("alert")).toContainText("This code is not valid or has expired");
});
