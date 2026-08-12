/**
 * The extractor's bounds and failure polarity (FR-DOC-003), pure unit:
 * the caps that keep one pathological file from unbounding the sweep,
 * and the classification line between "failed" (parser rejection —
 * deterministic, terminal) and "no text layer" (parses fine, says
 * nothing — a scan). The sweep-level consequences of these outcomes are
 * proven in the document-intelligence integration suite.
 */

import { describe, expect, it } from "vitest";
import { makeTextPdf } from "../../../__tests__/test-pdf.js";
import { extractPdfText, PdfNotReadableError } from "../pdf-text.js";

const CAPS = { maxPages: 200, maxPageChars: 100_000 };

describe("extractPdfText", () => {
  it("extracts per page, preserving blank pages so numbering matches the physical document", async () => {
    const out = await extractPdfText(
      makeTextPdf(["First page body.", "", "Third page body."]),
      CAPS,
    );
    expect(out.noTextLayer).toBe(false);
    expect(out.pages).toEqual(["First page body.", "", "Third page body."]);
  });

  it("truncates a huge document at maxPages instead of failing it", async () => {
    const huge = makeTextPdf(
      Array.from({ length: 205 }, (_, i) => `Content of page number ${i + 1}.`),
    );
    const out = await extractPdfText(huge, CAPS);
    expect(out.pages.length).toBe(200);
    expect(out.pages[199]).toContain("page number 200");
  });

  it("truncates a pathological page at maxPageChars instead of failing it", async () => {
    const out = await extractPdfText(makeTextPdf(["word ".repeat(60)]), {
      maxPages: 200,
      maxPageChars: 40,
    });
    expect(out.pages[0]?.length).toBe(40);
  });

  it("rejects garbage bytes with PdfNotReadableError — the deterministic, terminal polarity", async () => {
    await expect(
      extractPdfText(new TextEncoder().encode("not a pdf at all"), CAPS),
    ).rejects.toThrowError(PdfNotReadableError);
  });

  it("classifies stray-glyph documents as no text layer — never 'extracted' noise", async () => {
    // A scanner's accidental handful of characters across the file.
    const out = await extractPdfText(makeTextPdf(["", "x", "", "y z"]), CAPS);
    expect(out.noTextLayer).toBe(true);

    // Twenty meaningful characters is a real (if terse) text layer.
    const terse = await extractPdfText(makeTextPdf(["Decree passed as prayed."]), CAPS);
    expect(terse.noTextLayer).toBe(false);
  });
});
