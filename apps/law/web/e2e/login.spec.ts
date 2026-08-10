/**
 * The login working-day flow (T04b.1 gate): sign in → authorized call
 * (WhoAmI renders the user's name) → session survives a reload (refresh
 * cookie resume) → sign out lands back on login. Server sentences are
 * asserted verbatim — they are contract text (errors are UX).
 */

import { expect, test } from "@playwright/test";
import { ASHA, UNIFORM_LOGIN_FAILURE } from "./fixtures.js";

test("a signed-out visitor is routed to login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel("Email")).toBeVisible();
});

test("wrong password answers the uniform failure, verbatim", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ASHA.email);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText(UNIFORM_LOGIN_FAILURE);
  await expect(page).toHaveURL(/\/login$/);
});

test("sign in → resumed session on reload → sign out", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ASHA.email);
  await page.getByLabel("Password").fill(ASHA.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  // Signed in: the shell carries the WhoAmI identity (the authorized
  // call) — the profile link is the user's own name.
  await expect(page.getByRole("banner").getByRole("link", { name: ASHA.name })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);

  // Reload drops the in-memory access token — the session must resume
  // from the refresh cookie without showing the login form.
  await page.reload();
  await expect(page.getByRole("banner").getByRole("link", { name: ASHA.name })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  // Signed out for real: a deep link goes back to login.
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
});
