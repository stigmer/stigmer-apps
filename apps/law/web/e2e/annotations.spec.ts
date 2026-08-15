/**
 * Document annotations through the REAL UI (T13, DD-010): a text
 * selection on a born-digital PDF becomes a highlight with per-line
 * rects and quoted text; a drag on an image becomes a region mark;
 * both read back in the panel (author, quote/region, comment) and
 * jump-to-page rides the reader controller. Real backend, real
 * Postgres, real rendered geometry — the layer jsdom cannot see.
 *
 * The selection is DRIVEN programmatically (a Range over the text
 * layer + a pointerup on the surface): headless mouse-drags over glyph
 * coordinates proved flaky against pdfjs's absolutely-positioned
 * spans, and what the flow under test needs is a real Selection object
 * with real client rects — which this provides. The drag path is
 * exercised for real on the image leg.
 */

import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ASHA } from "./fixtures.js";
import { makePng } from "./test-png.js";
import { makeTextPdf } from "./test-pdf.js";

const PDF_PAGES = [
  "FICTIONAL WRITTEN STATEMENT - The suit is barred by limitation",
  "Second page: reply on merits follows",
] as const;
const PDF_BYTES = makeTextPdf(PDF_PAGES);

// A real-sized image: the region drag needs a drawing surface with
// area (a 1×1 fixture renders one CSS pixel — sub-minimum drags only).
const PNG_BYTES = makePng(600, 400);

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ASHA.email);
  await page.getByLabel("Password").fill(ASHA.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
}

async function createMatterWithDocuments(page: Page, fileNumber: string) {
  await page.goto("/cases/new");
  await page.getByLabel("Client", { exact: true }).fill("Theta Mills");
  await page.getByRole("button", { name: "Add a new client" }).click();
  await page.getByRole("button", { name: "Add client" }).click();
  await page.getByLabel("File number").fill(fileNumber);
  await page.getByLabel("Our client is the").selectOption({ label: "Plaintiff" });
  await page.getByLabel("Opposing party 1 name").fill("Sunrise Traders");
  await page.getByLabel("Forum", { exact: true }).selectOption({ label: "District Court" });
  await page.getByLabel("Court or forum name").fill("III Addl District Court");
  await page.getByLabel("Case type").fill("civil");
  await page.getByRole("button", { name: "Create case" }).click();
  await expect(page.getByRole("heading", { name: fileNumber })).toBeVisible();

  await page.getByRole("button", { name: "Documents" }).click();
  await page.locator("#document-upload").setInputFiles([
    { name: "written-statement.pdf", mimeType: "application/pdf", buffer: PDF_BYTES },
    { name: "order-sheet.png", mimeType: "image/png", buffer: PNG_BYTES },
  ]);
  const docs = page.getByRole("region", { name: "Documents" });
  await expect(docs.getByText("written-statement.pdf")).toBeVisible();
  await expect(docs.getByText("order-sheet.png")).toBeVisible();
}

/** Selects the first `chars` characters of page 1's text layer and
 * completes the gesture (pointerup on the reading surface). */
async function selectOnPageOne(page: Page, chars: number) {
  await page.evaluate((count) => {
    const layer = document.querySelector('[data-page-number="1"] .law-pdf-text-layer');
    if (!layer) throw new Error("page 1 text layer not rendered");
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (!node?.textContent) throw new Error("page 1 has no text nodes");
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(count, node.textContent.length));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, chars);
}

test("mark a highlight on a PDF, a region on an image; both read in the panel; jump-to-page works", async ({ page }) => {
  await signIn(page);
  await createMatterWithDocuments(page, "CS/2026/113");
  const docs = page.getByRole("region", { name: "Documents" });

  // ---- the highlight leg (born-digital PDF) ----

  await docs
    .getByRole("listitem")
    .filter({ hasText: "written-statement.pdf" })
    .getByRole("button", { name: "View" })
    .click();
  const reader = page.getByRole("region", { name: "written-statement.pdf", exact: true });
  await expect(reader).toBeVisible();
  await expect(reader.getByText(PDF_PAGES[0])).toBeVisible();

  await selectOnPageOne(page, 25);
  await reader.dispatchEvent("pointerup");
  await page.getByRole("button", { name: "Add mark" }).click();

  const panel = page.getByRole("region", { name: "Marks" });
  await expect(panel.getByText("New mark — page 1")).toBeVisible();
  await page.getByLabel("Comment").fill("Limitation defence — flag for the junior.");
  await page.getByRole("button", { name: "Save mark" }).click();

  // The saved mark: on the page (a real positioned highlight box over
  // real glyphs) and in the panel (author, quote, comment).
  await expect(reader.locator(".law-mark-highlight").first()).toBeVisible();
  await expect(panel.getByText(ASHA.name)).toBeVisible();
  // The quote is the SELECTED text — exactly 25 characters of page 1.
  await expect(panel.getByText("FICTIONAL WRITTEN STATEME", { exact: true })).toBeVisible();
  await expect(panel.getByText("Limitation defence — flag for the junior.")).toBeVisible();

  // The highlight geometry is sane: the mark's box sits INSIDE the
  // page box (normalized anchors can never render off-page).
  const markBox = await reader.locator(".law-mark-highlight").first().boundingBox();
  const pageBox = await reader.locator(".law-pdf-page").first().boundingBox();
  expect(markBox && pageBox && markBox.x >= pageBox.x - 1).toBe(true);
  expect(
    markBox && pageBox && markBox.x + markBox.width <= pageBox.x + pageBox.width + 1,
  ).toBe(true);

  // Jump from the panel rides the reader controller and lands ON the
  // mark — the reading-line convention keeps the indicator on the
  // mark's own page.
  await page.getByRole("button", { name: "Mark region" }).waitFor(); // toolbar settled
  await panel.getByRole("button", { name: "Page 1 →" }).waitFor();
  await page.getByLabel("Go to page").fill("2");
  await page.getByLabel("Go to page").press("Enter");
  await expect(page.getByLabel("Go to page")).toHaveValue("2");
  await panel.getByRole("button", { name: "Page 1 →" }).click();
  await expect(page.getByLabel("Go to page")).toHaveValue("1");

  // ---- mark identity: TWO marks on the SAME page (the reported
  // ambiguity) — numbered badges + bidirectional linking resolve it ----

  await page.getByRole("button", { name: "Mark region" }).click();
  const pageOneDrawLayer = page.locator('[data-page-number="1"] [data-region-draw-layer]');
  const drawBox = await pageOneDrawLayer.boundingBox();
  if (!drawBox) throw new Error("page 1 draw layer has no box");
  await page.mouse.move(drawBox.x + drawBox.width * 0.55, drawBox.y + drawBox.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(drawBox.x + drawBox.width * 0.8, drawBox.y + drawBox.height * 0.7, {
    steps: 5,
  });
  await page.mouse.up();
  await expect(panel.getByText("New mark — page 1 (marked region)")).toBeVisible();
  await page.getByLabel("Comment").fill("Second flag on the same page.");
  await page.getByRole("button", { name: "Save mark" }).click();

  // Creation-order numbers on the page and (implicitly, same numbers)
  // in the panel rows.
  await expect(reader.getByRole("button", { name: "Mark 1 on page 1" })).toBeVisible();
  await expect(reader.getByRole("button", { name: "Mark 2 on page 1" })).toBeVisible();
  const rows = panel.getByRole("listitem");
  await expect(rows).toHaveCount(2);

  // Row → mark: jumping from row 2 focuses ITS rect (the region),
  // never the other page-1 mark.
  await rows.nth(1).getByRole("button", { name: "Page 1 →" }).click();
  await expect(reader.locator(".law-mark-region.law-mark-focused")).toBeVisible();
  await expect(reader.locator(".law-mark-highlight.law-mark-focused")).toHaveCount(0);

  // Badge → row: selecting mark 1 on the page lights its panel row
  // and moves the focus emphasis to the highlight.
  await reader.getByRole("button", { name: "Mark 1 on page 1" }).click();
  await expect(rows.nth(0)).toHaveAttribute("aria-current", "true");
  await expect(reader.locator(".law-mark-highlight.law-mark-focused").first()).toBeVisible();
  await expect(reader.locator(".law-mark-region.law-mark-focused")).toHaveCount(0);

  // The rects stayed passive: text selection still works over a
  // marked area (the badge, not the rect, owns pointer events).
  await selectOnPageOne(page, 10);
  await reader.dispatchEvent("pointerup");
  await expect(page.getByRole("button", { name: "Add mark" })).toBeVisible();

  // The viewer with marks, badges, and panel faces the axe gate like
  // every screen.
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    blocking,
    blocking.map((v) => `${v.id} (${v.impact}): ${v.help}`).join("; "),
  ).toEqual([]);

  await page.getByRole("button", { name: "Close", exact: true }).click();

  // ---- the region leg (image — the scan-heavy corpus's workhorse) ----

  await docs
    .getByRole("listitem")
    .filter({ hasText: "order-sheet.png" })
    .getByRole("button", { name: "View" })
    .click();
  await expect(page.getByRole("img", { name: "order-sheet.png" })).toBeVisible();
  // No text exists here, so no highlight affordance exists either —
  // the capability matrix as UI truth (DD-010).
  await expect(page.getByRole("button", { name: "Add mark" })).toHaveCount(0);

  await page.getByRole("button", { name: "Mark region" }).click();
  const layer = page.locator("[data-region-draw-layer]");
  const box = await layer.boundingBox();
  if (!box) throw new Error("draw layer has no box");
  // A REAL drag this time — the pointer path the jsdom suite cannot walk.
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7, { steps: 5 });
  await page.mouse.up();

  await expect(page.getByText("New mark — page 1 (marked region)")).toBeVisible();
  await page.getByLabel("Comment").fill("Stamp area — verify with the registry.");
  await page.getByRole("button", { name: "Save mark" }).click();

  await expect(page.locator(".law-mark-region").first()).toBeVisible();
  const imagePanel = page.getByRole("region", { name: "Marks" });
  await expect(imagePanel.getByText("Marked region")).toBeVisible();
  await expect(imagePanel.getByText("Stamp area — verify with the registry.")).toBeVisible();

  // Reopening reads the trail back from the server, not client state.
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await docs
    .getByRole("listitem")
    .filter({ hasText: "order-sheet.png" })
    .getByRole("button", { name: "View" })
    .click();
  await expect(
    page.getByRole("region", { name: "Marks" }).getByText("Stamp area — verify with the registry."),
  ).toBeVisible();
  await expect(page.locator(".law-mark-region").first()).toBeVisible();
});

test("a selection spanning two pages is refused with the honest message", async ({ page }) => {
  await signIn(page);
  await createMatterWithDocuments(page, "CS/2026/114");
  await page
    .getByRole("region", { name: "Documents" })
    .getByRole("listitem")
    .filter({ hasText: "written-statement.pdf" })
    .getByRole("button", { name: "View" })
    .click();
  const reader = page.getByRole("region", { name: "written-statement.pdf", exact: true });
  await expect(reader.getByText(PDF_PAGES[0])).toBeVisible();
  await expect(reader.getByText(PDF_PAGES[1])).toBeVisible();

  await page.evaluate(() => {
    const textOf = (n: number) => {
      const layer = document.querySelector(`[data-page-number="${n}"] .law-pdf-text-layer`);
      if (!layer) throw new Error(`page ${n} text layer not rendered`);
      const node = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT).nextNode();
      if (!node?.textContent) throw new Error(`page ${n} has no text`);
      return node;
    };
    const range = document.createRange();
    range.setStart(textOf(1), 0);
    range.setEnd(textOf(2), 5);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await reader.dispatchEvent("pointerup");

  await expect(page.getByText("Select within a single page to mark it.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add mark" })).toHaveCount(0);
});
