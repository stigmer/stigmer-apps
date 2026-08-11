/**
 * The cross-cutting quality gates (T04b.4):
 *
 * - Performance envelope (FR-PERF-001, test-assertable by decree): list
 *   screens content-visible within 2s of navigation, mutations answered
 *   within 3s — asserted as Playwright expect timeouts on a warm session.
 * - Accessibility (D5): axe-core scans of every screen; serious/critical
 *   violations fail the build.
 */

import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ASHA, SEED_CASE } from "./fixtures.js";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ASHA.email);
  await page.getByLabel("Password").fill(ASHA.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
}

test("performance envelope: 2s list loads, 3s mutations (FR-PERF-001)", async ({ page }) => {
  await signIn(page); // warm: bundle cached, session live

  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Cases" }).click();
  await expect(page.getByRole("heading", { name: "Cases" })).toBeVisible({ timeout: 2_000 });
  await expect(page.getByRole("link", { name: /New case/ })).toBeVisible({ timeout: 2_000 });

  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Tasks" }).click();
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible({ timeout: 2_000 });

  // Mutation: a case note round-trips within 3s.
  await page.goto("/cases");
  await page.getByRole("link", { name: new RegExp(SEED_CASE.fileNumber.replaceAll("/", "\\/")) }).click();
  await page.getByRole("button", { name: "Notes" }).click();
  await page.getByLabel("Add a note").fill(`Perf envelope check ${Date.now()}`);
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByText(/Perf envelope check/).first()).toBeVisible({ timeout: 3_000 });
});

test("the facts rail answers to the content's width, not the window's (container query)", async ({ page }) => {
  await signIn(page);
  await page.goto("/cases");
  await page.getByRole("link", { name: new RegExp(SEED_CASE.fileNumber.replaceAll("/", "\\/")) }).click();
  await expect(page.getByRole("heading", { name: SEED_CASE.fileNumber })).toBeVisible();

  const rail = page.getByRole("complementary", { name: "Matter facts" });
  const tabs = page.getByRole("navigation", { name: "Matter sections" });

  // Wide content area (default 1280 viewport): the rail sits BESIDE the
  // reading column.
  const wideRail = await rail.boundingBox();
  const wideTabs = await tabs.boundingBox();
  expect(wideRail && wideTabs && wideRail.x > wideTabs.x + wideTabs.width).toBe(true);

  // Narrow the window until the content area drops under the threshold:
  // the rail wraps BELOW the column — the same mechanism that makes room
  // for the assistant dock, driven by content width rather than viewport.
  // (700px, not 900: below lg the sidebar overlays instead of pushing,
  // so a 900px window still gives the content ~868px — deliberately MORE
  // side-by-side room than the old viewport breakpoint allowed.)
  await page.setViewportSize({ width: 700, height: 720 });
  const narrowRail = await rail.boundingBox();
  const narrowTabs = await tabs.boundingBox();
  expect(narrowRail && narrowTabs && narrowRail.y > narrowTabs.y).toBe(true);
  expect(narrowRail && narrowTabs && Math.abs(narrowRail.x - narrowTabs.x) < 2).toBe(true);
});

test("accessibility: no serious or critical axe violations on any screen", async ({ page }) => {
  const scan = async (label: string) => {
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(
      blocking,
      `${label}: ${blocking.map((v) => `${v.id} (${v.impact}): ${v.help}`).join("; ")}`,
    ).toEqual([]);
  };

  await page.goto("/login");
  await scan("login");

  await signIn(page);
  await scan("home");

  await page.goto("/cases");
  await scan("cases");

  await page.getByRole("link", { name: new RegExp(SEED_CASE.fileNumber.replaceAll("/", "\\/")) }).click();
  await expect(page.getByRole("heading", { name: SEED_CASE.fileNumber })).toBeVisible();
  await scan("case detail");

  await page.goto("/clients");
  await scan("clients");

  await page.goto("/money");
  await scan("money");

  await page.goto("/members");
  await scan("the firm");

  await page.goto("/tasks/new");
  await scan("task create");

  await page.goto("/inbox");
  await scan("inbox");

  await page.goto("/profile");
  await scan("profile");
});
