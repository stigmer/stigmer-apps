/**
 * The matter working-day flows on the rebuilt model: intake with the
 * inline client register and conflict check (J4), the diary with a
 * recorded outcome that auto-schedules the next hearing (J3,
 * FR-HEAR-001/002), the running record in notes, and real bytes through
 * the document routes (FR-DOC-001).
 */

import { expect, test, type Page } from "@playwright/test";
import { ASHA } from "./fixtures.js";
import { makeTextPdf } from "./test-pdf.js";

// A real multi-page text-layer PDF (fictional by construction): the
// T12 pdfjs reader renders in headless Chromium — unlike the retired
// native plugin frame — so the suite asserts REAL page content now.
const PDF_PAGES = [
  "FICTIONAL VAKALATNAMA - Beta Industries authorizes counsel",
  "The limitation period is preserved by this filing",
  "Prayer: adjournment sought for recording evidence",
] as const;
const PDF_BYTES = makeTextPdf(PDF_PAGES);

// A 1×1 PNG for the image renderer's decoded-pixels proof.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ASHA.email);
  await page.getByLabel("Password").fill(ASHA.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
}

/** Intake with a brand-new client, created inline (J4). */
async function createMatter(page: Page, fileNumber: string, clientName: string) {
  await page.goto("/cases/new");
  await page.getByLabel("Client", { exact: true }).fill(clientName);
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
  await expect(page.getByRole("status").first()).toContainText(
    "Next hearing scheduled for 12/09/2099",
  );
  // The case's derived next date follows — read from the context rail,
  // the facts surface (the diary shows the same date in the story).
  await expect(
    page.getByRole("complementary", { name: "Matter facts" }).getByText("12/09/2099"),
  ).toBeVisible();

  // Capture at the source (FR-HEAR-007): the follow-up window opened
  // with the outcome; leave the task unassigned so it lands on the
  // home screen's pickup list (asserted at the end of this journey).
  await page.getByRole("button", { name: "Add a follow-up task" }).click();
  // The due date defaulted to the auto-scheduled next hearing.
  await expect(page.getByLabel(/Due date/)).toHaveValue("2099-09-12");
  await page.getByLabel("What has to be done").fill("Draft evidence affidavit");
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await expect(page.getByText(/waiting for an owner/)).toBeVisible();

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

  // View opens the IN-APP reading frame (T09.2/T12) — same window, the
  // URL carrying ?doc=. The pdfjs reader renders in headless CI, so
  // the assertions are REAL: painted canvas pixels, the selectable
  // text layer's content, and the app-owned chrome.
  await pdfRow.getByRole("button", { name: "View" }).click();
  // exact: the outer frame is "Document vakalatnama.pdf"; the reading
  // surface itself is the bare file name — Playwright name matching is
  // substring by default and the weak form matched the frame even when
  // the reader had failed into its error state.
  const reader = page.getByRole("region", { name: "vakalatnama.pdf", exact: true });
  await expect(reader).toBeVisible();
  expect(page.url()).toContain("doc=");
  await expect(page.getByText(`/ ${PDF_PAGES.length}`)).toBeVisible();

  // Page 1's text layer carries the actual document text — this is
  // what makes selection (and T13's highlights) possible, and it only
  // renders if the worker AND the standard-font assets shipped.
  await expect(reader.getByText(PDF_PAGES[0])).toBeVisible();
  // Painted pixels, not just elements: sample the canvas for any
  // non-blank pixel — the honest replacement for the retired
  // "frame + blob: src" workaround that could not see inside the
  // native plugin.
  await expect
    .poll(() =>
      reader
        .locator("canvas")
        .first()
        .evaluate((el) => {
          const canvas = el as HTMLCanvasElement;
          const context = canvas.getContext("2d");
          if (!context || canvas.width === 0) return false;
          const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
          for (let i = 0; i < data.length; i += 401) {
            if (data[i] !== 255 && data[i] !== 0) return true;
          }
          return false;
        }),
    )
    .toBe(true);

  // The in-viewer find searches the WHOLE document: the phrase lives
  // on page 3, outside the initial render window.
  await page.getByRole("button", { name: "Find" }).click();
  await page.getByLabel("Find in document").fill("adjournment sought");
  await expect(page.getByText("1 of 1")).toBeVisible();
  await page.getByLabel("Find in document").press("Enter");
  await expect(page.getByLabel("Go to page")).toHaveValue("3");
  await expect(reader.getByText(PDF_PAGES[2])).toBeVisible();

  // Zoom is app-owned chrome now; the percent display follows.
  const zoomBefore = await page.getByText(/%$/).textContent();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByText(/%$/)).not.toHaveText(zoomBefore ?? "");

  // exact: the sidebar's "Close navigation" also answers to /Close/.
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(docs.getByText("vakalatnama.pdf")).toBeVisible();

  // The ?page= deep link (the assistant-citation / search-hit seam):
  // app-controlled scroll-to-page, asserted by the indicator.
  await pdfRow.getByRole("button", { name: "View" }).click();
  await expect(reader).toBeVisible();
  const deepLink = new URL(page.url());
  deepLink.searchParams.set("page", "2");
  await page.goto(deepLink.toString());
  await expect(page.getByLabel("Go to page")).toHaveValue("2");
  await page.getByRole("button", { name: "Close", exact: true }).click();

  const pngRow = docs.getByRole("listitem").filter({ hasText: "order-sheet.png" });
  await pngRow.getByRole("button", { name: "View" }).click();
  const image = page.getByRole("img", { name: "order-sheet.png" });
  await expect(image).toBeVisible();
  // Decoded pixels, not just an element: the byte route → blob → img
  // path really delivered the image.
  await expect
    .poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  // Opening PUSHED history, so Back is "close the document".
  await page.goBack();
  await expect(docs.getByText("order-sheet.png")).toBeVisible();

  // Search inside the matter (FR-DOC-004 on the web). The e2e server
  // deliberately never runs the extraction sweep (no background writes),
  // so fresh uploads have no page rows — what e2e proves is the
  // list-for-results swap and the HONEST empty state. Hit rendering and
  // the ?doc/?page deep link are pinned by component tests; real
  // extraction and matching by the backend integration suite.
  const documentSearch = page.getByLabel(/Search inside this matter/);
  await documentSearch.fill("limitation");
  await expect(docs.getByText("No pages match")).toBeVisible();
  await expect(docs.getByText(/scans are searchable only after the system has read them/i)).toBeVisible();
  await documentSearch.fill("");
  await expect(docs.getByText("vakalatnama.pdf")).toBeVisible();

  // The communication loop closes on home (FR-HEAR-007, FR-TASK-002):
  // the outcome this journey recorded happened TODAY, so the story
  // panel tells it, and the unassigned follow-up sits on the pickup
  // list for whoever is free.
  await page.goto("/");
  const story = page.getByRole("region", { name: "What happened today" });
  await expect(story.getByText("CRL/2026/055").first()).toBeVisible();
  await expect(story.getByText(/Adjourned — next 12\/09\/2099/)).toBeVisible();
  const pickup = page.getByRole("region", { name: "Tasks waiting for an owner" });
  await expect(pickup.getByText("Draft evidence affidavit")).toBeVisible();
});

test("the conflict check fires DURING intake when the name is on the other side", async ({ page }) => {
  await signIn(page);
  // First matter puts "Sunrise Traders" on the other side.
  await createMatter(page, "CRL/2026/077", "Gamma Traders");

  // Second intake: typing the opposing name into the CLIENT search
  // surfaces the conflict panel before anything is created.
  await page.goto("/cases/new");
  await page.getByLabel("Client", { exact: true }).fill("Sunrise Traders");
  const conflict = page.getByTestId("conflict-check");
  await expect(conflict).toContainText("Sunrise Traders");
  await expect(conflict).toContainText("CRL/2026/077");
});

test("a duplicate file number answers the server's ALREADY_EXISTS sentence", async ({ page }) => {
  await signIn(page);
  await createMatter(page, "CRL/2026/088", "Epsilon & Co");

  await page.goto("/cases/new");
  await page.getByLabel("Client", { exact: true }).fill("Epsilon & Co");
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
