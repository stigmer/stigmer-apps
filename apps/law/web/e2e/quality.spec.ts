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
import { makeTextPdf } from "./test-pdf.js";

// The reading-frame scan uses a REAL text PDF: the T12 pdfjs reader is
// ordinary DOM (unlike the retired native plugin frame axe could never
// inject into), so the viewer chrome, find bar, and page landmarks all
// face the same gate as every screen — a first.
const PDF_BYTES = makeTextPdf(["FICTIONAL AXE FIXTURE - one page of readable text"]);

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

  // The DISCRIMINATING width (DD-007 §5a): at 1050px with the sidebar
  // pushing (lg+), the content container is ~762px — squarely in the
  // band where the ORIGINAL 48rem threshold stacked but the amended
  // 36rem one must NOT. This is the dock-open squeeze, simulated by
  // window width; without this assertion a viewport-breakpoint
  // regression would pass the wide and narrow checks identically.
  await page.setViewportSize({ width: 1050, height: 720 });
  const midRail = await rail.boundingBox();
  const midTabs = await tabs.boundingBox();
  expect(midRail && midTabs && midRail.x > midTabs.x + midTabs.width).toBe(true);

  // Narrow the window until the content area drops under the @xl
  // threshold: the rail wraps BELOW the column. The threshold is
  // deliberately LOW (DD-007 amendment): opening the Ask AI dock must
  // not reflow the page — both columns just get narrower — so stacking
  // is reserved for widths where two columns stop being legible.
  await page.setViewportSize({ width: 500, height: 720 });
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

  // The document reading frame (T09.2/T12): upload a fixture, open the
  // pdfjs reader, and open its find bar — the full viewer chrome faces
  // the same gate as every screen.
  await page.getByRole("button", { name: "Documents" }).click();
  await page
    .locator("#document-upload")
    .setInputFiles([{ name: "axe-fixture.pdf", mimeType: "application/pdf", buffer: PDF_BYTES }]);
  await page
    .getByRole("listitem")
    .filter({ hasText: "axe-fixture.pdf" })
    .getByRole("button", { name: "View" })
    .click();
  // exact: substring matching would also answer the outer
  // "Document axe-fixture.pdf" frame (see cases.spec).
  const reader = page.getByRole("region", { name: "axe-fixture.pdf", exact: true });
  await expect(reader).toBeVisible();
  await expect(reader.getByText(/FICTIONAL AXE FIXTURE/)).toBeVisible();
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByLabel("Find in document")).toBeVisible();
  await scan("document viewer");

  await page.goto("/clients");
  await scan("clients");

  await page.goto("/library");
  await scan("library");

  await page.goto("/money");
  await scan("money");

  await page.goto("/members");
  await scan("the firm");

  await page.goto("/tasks/new");
  await scan("task create");

  await page.goto("/inbox");
  await scan("inbox");

  await page.goto("/guide");
  await scan("guide");

  await page.goto("/profile");
  await scan("profile");
});

test("the pdfjs asset directories ship beside the build (T12)", async ({ page }) => {
  // Standard fonts are implicitly proven by the reader tests (the
  // fixture's non-embedded Helvetica cannot render without them), but
  // CMaps are fetched only by CID-encoded documents no fixture covers —
  // this probe is their artifact-presence gate (the missing-worker
  // defect class, session 14).
  const cmap = await page.request.get("/pdf-assets/cmaps/78-H.bcmap");
  expect(cmap.status()).toBe(200);
  const font = await page.request.get("/pdf-assets/standard_fonts/FoxitFixed.pfb");
  expect(font.status()).toBe(200);
});
