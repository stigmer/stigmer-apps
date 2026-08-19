/**
 * The firm library (FR-DOC-005 + FR-CIT-002): the citation shelf's
 * front door and the reliance-trail loop — upload a judgment to the
 * library, read it in the library's own viewer, and record where the
 * firm used it. Real bytes through the real library route; the pdfjs
 * reader asserts actual page content (the T12 discipline).
 */

import { expect, test, type Page } from "@playwright/test";
import { ASHA } from "./fixtures.js";
import { makeTextPdf } from "./test-pdf.js";

const JUDGMENT_PDF = makeTextPdf([
  "FICTIONAL GUIDELINES - Bail is the rule where the offence carries under seven years.",
]);

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ASHA.email);
  await page.getByLabel("Password").fill(ASHA.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
}

/** Self-contained matter (the cases.spec helper's shape) — specs must
 * never depend on another spec's writes (parallel workers). */
async function createMatter(page: Page, fileNumber: string, clientName: string) {
  await page.goto("/cases/new");
  await page.getByLabel("Client", { exact: true }).fill(clientName);
  await page.getByRole("button", { name: "Add a new client" }).click();
  await page.getByRole("button", { name: "Add client" }).click();
  // Wait for the client to BIND to the form (the createMatter flake's
  // fix — cases.spec).
  await expect(page.getByRole("button", { name: "Change client" })).toBeVisible();
  await page.getByLabel("File number").fill(fileNumber);
  await page.getByLabel("Our client is the").selectOption({ label: "Plaintiff" });
  await page.getByLabel("Opposing party 1 name").fill("Sunrise Traders");
  await page.getByLabel("Forum", { exact: true }).selectOption({ label: "District Court" });
  await page.getByLabel("Court or forum name").fill("III Addl District Court");
  await page.getByLabel("Case type").fill("civil");
  await page.getByRole("button", { name: "Create case" }).click();
  await expect(page.getByRole("heading", { name: fileNumber })).toBeVisible();
}

test("upload a judgment, read it in the library, record where the firm used it", async ({ page }) => {
  await signIn(page);

  // A matter to record the use against, created first so the shelf's
  // "Record a use" picker has it.
  await createMatter(page, "CRL/2026/121", "Zeta Traders");

  // The front door: upload real bytes to the citation shelf.
  await page.goto("/library");
  await page
    .locator("#library-upload")
    .setInputFiles([
      { name: "fictional-guidelines.pdf", mimeType: "application/pdf", buffer: JUDGMENT_PDF },
    ]);
  await expect(page.getByRole("status")).toContainText("added to the library");

  const shelf = page.getByRole("region", { name: "Citations in the library" });
  await expect(shelf.getByText("fictional-guidelines.pdf")).toBeVisible();

  // Read opens the shared viewer IN PLACE (?doc=) and renders the
  // judgment's actual text — the whole point of the library.
  await shelf.getByRole("button", { name: "Read" }).click();
  const reader = page.getByRole("region", { name: "fictional-guidelines.pdf", exact: true });
  await expect(reader).toBeVisible();
  expect(page.url()).toContain("/library?");
  await expect(reader.getByText(/offence carries under seven years/)).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(shelf.getByText("fictional-guidelines.pdf")).toBeVisible();

  // The reliance trail (FR-CIT-002): record a use against the matter
  // and see it in the trail.
  await shelf.getByRole("button", { name: "Where we used it" }).click();
  await shelf.getByRole("button", { name: "Record a use" }).click();
  await page.getByLabel("Used in").selectOption({ label: "CRL/2026/121" });
  await page
    .getByLabel("For what proposition")
    .fill("bail where the offence carries under seven years");
  await page.getByRole("button", { name: "Record use" }).click();
  await expect(shelf.getByText(/bail where the offence carries under seven years/)).toBeVisible();
  await expect(shelf.getByText("CRL/2026/121")).toBeVisible();
});
