/**
 * Dock-open LAYOUT — the regression gate the assistant-disabled suite
 * structurally cannot provide (its deployment has no assistant, so the
 * SDK chunk and stylesheet never load). This project runs against the
 * fake-assistant server (see playwright.config.ts): the REAL dock, the
 * REAL @stigmer/react chunk + stylesheet, no agent platform dialed.
 *
 * What it pins, and why each nearly shipped (or shipped) broken:
 *
 * 1. The facts rail keeps two columns after the SDK stylesheet loads —
 *    stigmer/stigmer#454's live symptom: a second Tailwind build's
 *    unscoped utilities flipped the app's base+variant pairs the first
 *    time Ask AI opened. Fixed upstream in SDK 3.11 (prefix-isolated
 *    stylesheet); this holds the line here.
 * 2. Only the chat pane can scroll — the SDK provider container ships
 *    unsized by design (its DD-019 embedding contract), and without the
 *    host's fixed-height opt-in (assistant.css) the panel's content
 *    grew past the viewport and scrolled the whole document. Asserted
 *    at the mechanism: the container fills its bounded parent exactly.
 * 3. The phone sheet stays position:fixed — #454's latent twin
 *    (`relative` base beating the `max-lg:fixed` variant).
 * 4. The Ask AI entry points split by width: the right-edge strip on
 *    desktop, the sidebar entry below lg — one way in at every width,
 *    never two, never zero.
 */

import { expect, test, type Page } from "@playwright/test";
import { ASHA, SEED_CASE } from "./fixtures.js";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ASHA.email);
  await page.getByLabel("Password").fill(ASHA.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
}

/** The rail sits beside the reading column (not wrapped below it). */
async function expectTwoColumns(page: Page) {
  const rail = page.getByRole("complementary", { name: "Matter facts" });
  const tabs = page.getByRole("navigation", { name: "Matter sections" });
  await expect
    .poll(async () => {
      const railBox = await rail.boundingBox();
      const tabsBox = await tabs.boundingBox();
      if (!railBox || !tabsBox) return "not-rendered";
      return railBox.x > tabsBox.x + tabsBox.width ? "beside" : "stacked";
    })
    .toBe("beside");
}

test("dock-open layout: the rail holds, the dock owns its scroll, the sheet stays fixed", async ({
  page,
}) => {
  // Wide enough that the content keeps ≥36rem with the dock's default
  // 448px open — the rail must then HOLD two columns (DD-007 §5a).
  await page.setViewportSize({ width: 1600, height: 900 });
  await signIn(page);

  await page.goto("/cases");
  await page
    .getByRole("link", { name: new RegExp(SEED_CASE.fileNumber.replaceAll("/", "\\/")) })
    .click();
  await expect(page.getByRole("heading", { name: SEED_CASE.fileNumber })).toBeVisible();
  await expectTwoColumns(page);

  // Desktop offers exactly one way in: the strip, not the sidebar entry.
  const sidebarEntry = page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "Ask AI" });
  await expect(sidebarEntry).toBeHidden();

  // Open the dock; the SDK chunk (and its stylesheet) load NOW.
  await page.getByRole("button", { name: "Open Ask AI" }).click();
  await expect(page.getByLabel("Ask the assistant")).toBeVisible();

  // (1) The #454 regression: a second stylesheet is live in the
  // document and the app's container-query pair must still win.
  await expectTwoColumns(page);

  // (2) The DD-019 contract holds: the provider container fills its
  // bounded parent exactly (unsized, it would be content-height), so
  // the SDK's internal thread scroller is the only scrollable region…
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const root = document.querySelector(".law-assistant [data-stgm-root]");
        const parent = root?.parentElement;
        if (!root || !parent) return "not-rendered";
        const rootHeight = root.getBoundingClientRect().height;
        const parentHeight = parent.getBoundingClientRect().height;
        return Math.abs(rootHeight - parentHeight) < 1
          ? "bounded"
          : `root=${rootHeight} parent=${parentHeight}`;
      }),
    )
    .toBe("bounded");

  // …and the document itself has nothing to scroll.
  expect(
    await page.evaluate(() => {
      const doc = document.scrollingElement;
      return doc ? doc.scrollHeight - doc.clientHeight : -1;
    }),
  ).toBe(0);

  // (3) Below lg the open dock becomes the sheet — and must be FIXED
  // (the latent #454 twin: an unscoped `relative` once beat this).
  await page.setViewportSize({ width: 800, height: 700 });
  const sheet = page.getByRole("dialog", { name: "Ask AI" });
  await expect(sheet).toBeVisible();
  expect(await sheet.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");

  // (4) On a phone the strip does not exist; the sidebar entry is the
  // way in — visible now that the viewport is below lg.
  await page.getByRole("button", { name: "Close Ask AI" }).click();
  await expect(page.getByRole("button", { name: "Open Ask AI" })).toHaveCount(0);
  await expect(sidebarEntry).toBeVisible();
});
