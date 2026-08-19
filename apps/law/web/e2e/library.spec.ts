/**
 * The firm library (FR-DOC-005): the public-record shelf's front door
 * and the acts-with-their-texts loop — upload a bare act to the
 * library, read it in the library's own viewer, link it from a
 * matter's statutory frame, and land back in the text from "Read the
 * Act". Real bytes through the real library route; the pdfjs reader
 * asserts actual page content (the T12 discipline).
 */

import { expect, test, type Page } from "@playwright/test";
import { ASHA } from "./fixtures.js";
import { makeTextPdf } from "./test-pdf.js";

const ACT_PDF = makeTextPdf([
  "FICTIONAL PENAL CODE - Section 420. Cheating and dishonestly inducing delivery of property.",
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

test("upload a bare act, read it in the library, link it from a matter's frame", async ({ page }) => {
  await signIn(page);

  // The front door: pick the acts shelf, upload real bytes.
  await page.goto("/library");
  await page.getByLabel("Add to the library as").selectOption({ label: "Bare act (the statute's text)" });
  await page
    .locator("#library-upload")
    .setInputFiles([{ name: "fictional-penal-code.pdf", mimeType: "application/pdf", buffer: ACT_PDF }]);
  await expect(page.getByRole("status")).toContainText("added to the library");

  const actsPile = page.getByRole("region", { name: "Bare acts" });
  await expect(actsPile.getByText("fictional-penal-code.pdf")).toBeVisible();

  // Read opens the shared viewer IN PLACE (?doc=) and renders the
  // statute's actual text — the whole point of the library.
  await actsPile.getByRole("button", { name: "Read" }).click();
  const reader = page.getByRole("region", { name: "fictional-penal-code.pdf", exact: true });
  await expect(reader).toBeVisible();
  expect(page.url()).toContain("/library?");
  await expect(reader.getByText(/dishonestly inducing delivery/)).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(actsPile.getByText("fictional-penal-code.pdf")).toBeVisible();

  // The loop closes on a matter: link the act's text on the frame and
  // land back in it from "Read the Act".
  await createMatter(page, "CRL/2026/121", "Zeta Traders");
  await page.getByRole("button", { name: "Acts" }).click();
  await page.getByRole("button", { name: "Add act" }).click();
  await page.getByLabel("Act", { exact: true }).fill("Fictional Penal Code");
  await page.getByLabel(/Sections/).fill("420");
  await page.getByLabel(/The Act's text/).selectOption({ label: "fictional-penal-code.pdf" });
  await page.getByRole("button", { name: "Add act" }).click();

  await page.getByRole("link", { name: "Read the Act" }).click();
  await expect(
    page.getByRole("region", { name: "fictional-penal-code.pdf", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Section 420/).first()).toBeVisible();
});
