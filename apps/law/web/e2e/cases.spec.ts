/**
 * The matter working-day flows on the rebuilt model: intake with the
 * inline client register and conflict check (J4), the diary with a
 * recorded outcome that auto-schedules the next hearing (J3,
 * FR-HEAR-001/002), the running record in notes, and real bytes through
 * the document routes (FR-DOC-001).
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
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
}

/** Intake with a brand-new client, created inline (J4). */
async function createMatter(page: Page, fileNumber: string, clientName: string) {
  await page.goto("/cases/new");
  await page.getByLabel("Client").fill(clientName);
  await page.getByRole("button", { name: "Add a new client" }).click();
  await page.getByRole("button", { name: "Add client" }).click();
  await expect(page.getByText(clientName)).toBeVisible();

  await page.getByLabel("File number").fill(fileNumber);
  await page.getByLabel("Our client is the").selectOption({ label: "Plaintiff" });
  await page.getByLabel("Opposing party 1 name").fill("Sunrise Traders");
  await page.getByLabel("Forum", { exact: true }).selectOption({ label: "District Court" });
  await page.getByLabel("Court or forum name").fill("III Addl District Court");
  await page.getByLabel("Case type").fill("civil");
  await page.getByRole("button", { name: "Create case" }).click();
  await expect(page.getByRole("heading", { name: fileNumber })).toBeVisible();
}

test("intake → diary → recorded outcome auto-schedules → notes → documents", async ({ page }) => {
  await signIn(page);
  await createMatter(page, "CRL/2026/055", "Beta Industries");

  // Fresh matter: nothing scheduled — the loud "no next date" state.
  await expect(page.getByText(/No next date/)).toBeVisible();

  // Schedule the first hearing (FR-HEAR-001) — a past date, so the
  // outcome can be recorded in the same run.
  await page.getByRole("button", { name: "Schedule a hearing" }).click();
  await page.getByLabel("Date", { exact: true }).fill("2026-01-05");
  await page.getByLabel("Listed for").fill("filing of written statement");
  await page.getByRole("button", { name: "Schedule" }).click();
  await expect(page.getByText("05/01/2026")).toBeVisible();

  // The clerk's evening capture (FR-HEAR-006).
  await page.getByRole("button", { name: "Cause-list details" }).click();
  await page.getByLabel("List item no.").fill("47");
  await page.getByLabel("Court hall").fill("3");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("(item 47, hall 3)")).toBeVisible();

  // The capture moment (J3): adjourned, next date given — the next
  // hearing schedules itself and the case's next date follows.
  await page.getByRole("button", { name: "Record outcome" }).click();
  await page.getByLabel("What happened").selectOption({ label: "Adjourned" });
  await page.getByLabel(/Next date/).fill("2099-09-12");
  await page.getByLabel("Listed for").last().fill("evidence");
  await page.getByRole("form", { name: /Record outcome/ }).getByRole("button", { name: "Record outcome" }).click();
  await expect(page.getByRole("status")).toContainText("Next hearing scheduled for 12/09/2099");
  await expect(page.getByText("Next hearing 12/09/2099")).toBeVisible();

  // Notes: append-only running record, author from the envelope.
  await page.getByRole("button", { name: "Notes" }).click();
  await page.getByLabel("Add a note").fill("Client called about the bail application.");
  await page.getByRole("button", { name: "Add note" }).click();
  const notes = page.getByRole("region", { name: "Notes" });
  await expect(notes.getByText("Client called about the bail application.")).toBeVisible();
  await expect(notes.getByText(ASHA.name)).toBeVisible();

  // Documents: multi-file upload = repeated create; view + download.
  await page.getByRole("button", { name: "Documents" }).click();
  await page.locator("#document-upload").setInputFiles([
    { name: "vakalatnama.pdf", mimeType: "application/pdf", buffer: PDF_BYTES },
    { name: "order-sheet.png", mimeType: "image/png", buffer: PNG_BYTES },
  ]);
  const docs = page.getByRole("region", { name: "Documents" });
  await expect(docs.getByText("vakalatnama.pdf")).toBeVisible();
  await expect(docs.getByText("order-sheet.png")).toBeVisible();

  const pdfRow = docs.getByRole("listitem").filter({ hasText: "vakalatnama.pdf" });
  const downloadEvent = page.waitForEvent("download");
  await pdfRow.getByRole("button", { name: "Download" }).click();
  expect((await downloadEvent).suggestedFilename()).toBe("vakalatnama.pdf");

  const pngRow = docs.getByRole("listitem").filter({ hasText: "order-sheet.png" });
  const popupEvent = page.waitForEvent("popup");
  await pngRow.getByRole("button", { name: "View" }).click();
  const popup = await popupEvent;
  await popup.waitForURL(/^blob:/);
});

test("the conflict check fires DURING intake when the name is on the other side", async ({ page }) => {
  await signIn(page);
  // First matter puts "Sunrise Traders" on the other side.
  await createMatter(page, "CRL/2026/077", "Gamma Traders");

  // Second intake: typing the opposing name into the CLIENT search
  // surfaces the conflict panel before anything is created.
  await page.goto("/cases/new");
  await page.getByLabel("Client").fill("Sunrise Traders");
  const conflict = page.getByTestId("conflict-check");
  await expect(conflict).toContainText("Sunrise Traders");
  await expect(conflict).toContainText("CRL/2026/077");
});

test("a duplicate file number answers the server's ALREADY_EXISTS sentence", async ({ page }) => {
  await signIn(page);
  await createMatter(page, "CRL/2026/088", "Epsilon & Co");

  await page.goto("/cases/new");
  await page.getByLabel("Client").fill("Epsilon & Co");
  await page.getByTestId("client-search-results").getByRole("button", { name: /Epsilon & Co/ }).click();
  await page.getByLabel("File number").fill("CRL/2026/088");
  await page.getByLabel("Our client is the").selectOption({ label: "Defendant" });
  await page.getByLabel("Forum", { exact: true }).selectOption({ label: "District Court" });
  await page.getByLabel("Court or forum name").fill("II Addl District Court");
  await page.getByLabel("Case type").fill("civil");
  await page.getByRole("button", { name: "Create case" }).click();
  await expect(page.getByRole("alert")).toHaveText(/CRL\/2026\/088.*already exists/);
});

test("a task created from the matter is pre-bound and appears on its Tasks tab", async ({ page }) => {
  await signIn(page);
  await createMatter(page, "ARB/2026/099", "Zeta Logistics");

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("region", { name: "Tasks on this case" }).getByRole("link", { name: "New task" }).click();
  // Pre-bound: no file-number field, the matter named instead.
  await expect(page.getByText(/For matter/)).toContainText("ARB/2026/099");
  await expect(page.getByLabel("File number")).toHaveCount(0);
  await page.getByLabel("Title").fill("Prepare arbitration brief");
  await page.getByRole("button", { name: "Create task" }).click();
  await expect(page.getByRole("heading", { name: "Prepare arbitration brief" })).toBeVisible();

  // Back on the matter, the task is on its list.
  await page.getByRole("link", { name: "ARB/2026/099" }).click();
  await page.getByRole("button", { name: "Tasks" }).click();
  await expect(
    page.getByRole("region", { name: "Tasks on this case" }).getByText("Prepare arbitration brief"),
  ).toBeVisible();
});
