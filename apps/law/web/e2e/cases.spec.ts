/**
 * The case working-day flows (T04b.3 gate): create a case, see it in the
 * hearing-ordered list, edit it (full-spec replacement under D10), keep
 * the running record in notes, and move real bytes through the document
 * routes — upload, derived count, view, download (FR-CASE-001..006,
 * FR-INTEG-001).
 */

import { expect, test, type Page } from "@playwright/test";
import { ASHA } from "./fixtures.js";

const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

// A 1×1 PNG: the View assertion uses an image because headless Chromium
// has no PDF viewer (a PDF popup degrades to a download there, while
// headed Chrome renders it) — the image proves the view path end to end.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ASHA.email);
  await page.getByLabel("Password").fill(ASHA.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /Welcome,/ })).toBeVisible();
}

test("case lifecycle: create → list → edit → notes → documents", async ({ page }) => {
  await signIn(page);

  // Create.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Cases" }).click();
  await page.getByRole("link", { name: "New case" }).click();
  await page.getByLabel("Case number").fill("CRL-55/2026");
  await page.getByLabel("Client name").fill("Beta Industries");
  await page.getByLabel("Case type").fill("criminal");
  await page.getByLabel(/Next hearing date/).fill("2026-09-15");
  await page.getByRole("button", { name: "Create case" }).click();

  // Detail facts, DD/MM/YYYY.
  await expect(page.getByRole("heading", { name: "CRL-55/2026 — Beta Industries" })).toBeVisible();
  await expect(page.getByText("15/09/2026")).toBeVisible();
  // The assigned-lawyer fact (scoped: the header chip also carries her name).
  await expect(page.getByRole("definition").filter({ hasText: ASHA.name })).toBeVisible();

  // The list's at-a-glance pair.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Cases" }).click();
  const row = page.getByRole("link", { name: /CRL-55\/2026/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Hearing 15/09/2026");

  // Edit: full-spec replacement — the hearing moves, everything else holds.
  await row.click();
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel(/Next hearing date/).fill("2026-10-01");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("01/10/2026")).toBeVisible();
  await expect(page.getByRole("heading", { name: "CRL-55/2026 — Beta Industries" })).toBeVisible();

  // Notes: append-only running record, author from the envelope.
  await page.getByLabel("Add a note").fill("Client called about the bail application.");
  await page.getByRole("button", { name: "Add note" }).click();
  const notes = page.getByRole("region", { name: "Notes" });
  await expect(notes.getByText("Client called about the bail application.")).toBeVisible();
  await expect(notes.getByText(ASHA.name)).toBeVisible();

  // Documents: multi-file upload = repeated create (FR-CASE-005 AC10);
  // the case's derived document_count follows.
  await page.locator("#document-upload").setInputFiles([
    { name: "vakalatnama.pdf", mimeType: "application/pdf", buffer: PDF_BYTES },
    { name: "order-sheet.png", mimeType: "image/png", buffer: PNG_BYTES },
  ]);
  const docs = page.getByRole("region", { name: "Documents" });
  await expect(docs.getByText("vakalatnama.pdf")).toBeVisible();
  await expect(docs.getByText("order-sheet.png")).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: /^2$/ })).toBeVisible();

  // Download carries the original filename (FR-INTEG-001 AC4).
  const pdfRow = docs.getByRole("listitem").filter({ hasText: "vakalatnama.pdf" });
  const downloadEvent = page.waitForEvent("download");
  await pdfRow.getByRole("button", { name: "Download" }).click();
  expect((await downloadEvent).suggestedFilename()).toBe("vakalatnama.pdf");

  // View opens the bytes in a new tab (object URL — no auth in the URL).
  const pngRow = docs.getByRole("listitem").filter({ hasText: "order-sheet.png" });
  const popupEvent = page.waitForEvent("popup");
  await pngRow.getByRole("button", { name: "View" }).click();
  const popup = await popupEvent;
  await popup.waitForURL(/^blob:/);
});

test("a duplicate case number answers the server's ALREADY_EXISTS sentence", async ({ page }) => {
  await signIn(page);

  await page.goto("/cases/new");
  await page.getByLabel("Case number").fill("CRL-77/2026");
  await page.getByLabel("Client name").fill("Gamma Traders");
  await page.getByLabel("Case type").fill("civil");
  await page.getByRole("button", { name: "Create case" }).click();
  await expect(page.getByRole("heading", { name: /CRL-77\/2026/ })).toBeVisible();

  await page.goto("/cases/new");
  await page.getByLabel("Case number").fill("CRL-77/2026");
  await page.getByLabel("Client name").fill("Delta Traders");
  await page.getByLabel("Case type").fill("civil");
  await page.getByRole("button", { name: "Create case" }).click();
  await expect(page.getByRole("alert")).toHaveText(/CRL-77\/2026.*already exists/);
});

test("a task created from the case is pre-bound and appears on the case", async ({ page }) => {
  await signIn(page);

  await page.goto("/cases/new");
  await page.getByLabel("Case number").fill("CRL-88/2026");
  await page.getByLabel("Client name").fill("Epsilon & Co");
  await page.getByLabel("Case type").fill("arbitration");
  await page.getByRole("button", { name: "Create case" }).click();
  await expect(page.getByRole("heading", { name: /CRL-88\/2026/ })).toBeVisible();

  await page.getByRole("region", { name: "Tasks on this case" }).getByRole("link", { name: "New task" }).click();
  // Pre-bound: no case-number field, the case named instead.
  await expect(page.getByText(/For case/)).toContainText("CRL-88/2026");
  await expect(page.getByLabel("Case number")).toHaveCount(0);
  await page.getByLabel("Title").fill("Prepare arbitration brief");
  await page.getByRole("button", { name: "Create task" }).click();
  await expect(page.getByRole("heading", { name: "Prepare arbitration brief" })).toBeVisible();

  // Back on the case, the task is on its list.
  await page.getByRole("link", { name: "CRL-88/2026" }).click();
  await expect(
    page.getByRole("region", { name: "Tasks on this case" }).getByText("Prepare arbitration brief"),
  ).toBeVisible();
});
