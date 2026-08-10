/**
 * The two-tab session test (T04b.1 gate; D4). Refresh tokens are strictly
 * one-time-use with revoke-ALL-on-reuse (DD-005 D6), and every tab shares
 * the cookie — so two tabs booting at the same moment would, without the
 * kit's cross-tab lock, replay a consumed token and end every session
 * with the theft notice. This test drives exactly that scenario through
 * real Chromium tabs and asserts the working day survives it.
 */

import { expect, test, type Page } from "@playwright/test";
import { ASHA, THEFT_NOTICE } from "./fixtures.js";

async function expectSignedIn(page: Page) {
  await expect(page.getByRole("banner").getByRole("link", { name: ASHA.name })).toBeVisible();
  await expect(page.getByText(THEFT_NOTICE)).toHaveCount(0);
}

test("simultaneous boots in two tabs never trip the theft response", async ({ context, page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ASHA.email);
  await page.getByLabel("Password").fill(ASHA.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expectSignedIn(page);

  // A second tab of the same browser: it boots from the shared cookie.
  const second = await context.newPage();
  await second.goto("/");
  await expectSignedIn(second);

  // Three rounds of simultaneous reloads: each reload drops the tab's
  // in-memory token, so both tabs race to refresh the SAME cookie. The
  // Web Locks serialization is what keeps round N from being the last.
  for (let round = 0; round < 3; round += 1) {
    await Promise.all([page.reload(), second.reload()]);
    await expectSignedIn(page);
    await expectSignedIn(second);
  }
});
