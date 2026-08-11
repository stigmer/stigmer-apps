/**
 * The assistant's OPEN-SOURCE posture, end to end: the e2e backend boots
 * with no STIGMER_* configuration, so the deployment simply has no
 * assistant — the affordance must be absent (not broken, not erroring)
 * everywhere it would otherwise appear. The configured path cannot run
 * here (it needs the real agent platform); its live proof is the
 * production smoke in the rollout runbook.
 */

import { expect, test } from "@playwright/test";
import { ASHA, SEED_CASE } from "./fixtures.js";

test("an unconfigured deployment offers no Ask AI anywhere", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ASHA.email);
  await page.getByLabel("Password").fill(ASHA.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("link", { name: ASHA.name })).toBeVisible();

  // The sidebar renders its whole nav; the assistant entry is not in it —
  // and neither is the dock's right-edge strip.
  await expect(page.getByRole("link", { name: "Cases" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask AI" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open Ask AI" })).toHaveCount(0);

  // A matter's page renders its actions; the contextual entry is not
  // among them. (WP/2026/1234 is the e2e server's seeded matter.)
  await page.getByRole("link", { name: "Cases" }).click();
  await page.getByRole("link", { name: SEED_CASE.fileNumber }).click();
  await expect(page.getByRole("button", { name: "Edit details" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask AI about this matter" })).toHaveCount(0);
});
