/**
 * The citation shelf, end to end (FR-CIT-002 + DD-012 D2): file a
 * judgment with its identity through the front door, read it in the
 * library's own viewer, then walk the CASE-FIRST citing flow — a
 * matter's Citations tab, shelf search by the name a lawyer says,
 * proposition, recorded trail on both sides. Real bytes through the
 * real library route; the pdfjs reader asserts actual page content
 * (the T12 discipline).
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

test("file a judgment with identity, read it on the shelf, cite it from a matter", async ({ page }) => {
  await signIn(page);

  // A matter to cite from, created first.
  await createMatter(page, "CRL/2026/121", "Zeta Traders");

  // The front door: identity beside the bytes (DD-012 D2).
  await page.goto("/library");
  await page
    .getByLabel("Case name (as the firm cites it)")
    .fill("Fictional Guidelines vs State");
  // exact: the shelf section's aria-label ("Citations on the shelf")
  // substring-matches "Citation" otherwise — a strict-mode violation.
  await page.getByLabel("Citation", { exact: true }).fill("AIR 2099 SC 1");
  await page
    .locator("#library-upload")
    .setInputFiles([
      { name: "fictional-guidelines.pdf", mimeType: "application/pdf", buffer: JUDGMENT_PDF },
    ]);
  await expect(page.getByRole("status")).toContainText("on the shelf");

  // The shelf leads with the IDENTITY, the file name is small print.
  const shelf = page.getByRole("region", { name: "Citations on the shelf" });
  await expect(shelf.getByText("Fictional Guidelines vs State")).toBeVisible();
  await expect(shelf.getByText(/AIR 2099 SC 1/)).toBeVisible();

  // Read opens the shared viewer IN PLACE (?doc=) and renders the
  // judgment's actual text — the whole point of the library.
  await shelf.getByRole("button", { name: "Read" }).first().click();
  const reader = page.getByRole("region", { name: "fictional-guidelines.pdf", exact: true });
  await expect(reader).toBeVisible();
  expect(page.url()).toContain("/library?");
  await expect(reader.getByText(/offence carries under seven years/)).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(shelf.getByText("Fictional Guidelines vs State")).toBeVisible();

  // The CASE-FIRST citing flow (DD-012 D2): from the matter, search
  // the shelf by the name a lawyer says, pick, state the proposition.
  await page.goto("/cases");
  await page.getByRole("link", { name: /CRL\/2026\/121/ }).click();
  await page.getByRole("button", { name: "Citations" }).click();
  await page.getByRole("button", { name: "Cite a judgment" }).click();
  await page.getByLabel(/Find it on the firm's shelf/).fill("Fictional");
  await expect(page.getByText("Fictional Guidelines vs State")).toBeVisible();
  await page.getByRole("button", { name: "Cite this" }).click();
  await page
    .getByLabel("For what proposition")
    .fill("bail where the offence carries under seven years");
  await page.getByRole("button", { name: "Record the citation" }).click();

  // The matter's trail carries it…
  const citations = page.getByRole("region", { name: "Citations" });
  await expect(citations.getByText("fictional-guidelines.pdf")).toBeVisible();
  await expect(
    citations.getByText(/bail where the offence carries under seven years/),
  ).toBeVisible();

  // …and the Library's reverse view answers the same fact
  // (cross-surface coherence: one trail, two doors).
  await page.goto("/library");
  await shelf.getByRole("button", { name: "Where we used it" }).first().click();
  await expect(shelf.getByText("CRL/2026/121")).toBeVisible();
  await expect(
    shelf.getByText(/bail where the offence carries under seven years/),
  ).toBeVisible();
});
