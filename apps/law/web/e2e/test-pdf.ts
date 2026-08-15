/**
 * Minimal, valid, text-layer PDF builder for the e2e suite — a copy of
 * the backend's apps/law/backend/src/__tests__/test-pdf.ts makeTextPdf
 * (one Helvetica text run per page, correct xref offsets, zero
 * dependencies). Copied, not imported: a web-package reach into
 * backend/src would breach the package boundary for a test fixture;
 * the ~50 duplicated lines are the honest cost, and the backend copy
 * stays the canonical one. Keep the two in step if the builder ever
 * changes.
 *
 * The built pages use NON-EMBEDDED Helvetica on purpose: rendering
 * them in the viewer forces pdfjs to fetch standard-font data, so a
 * missing /pdf-assets/ deployment fails this suite instead of a
 * customer (the session-14 missing-artifact lesson).
 */

const encoder = new TextEncoder();

function escapePdfText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Serializes numbered objects plus the xref table and trailer. */
function assemblePdf(objects: readonly string[]): Uint8Array {
  let body = `%PDF-1.4\n`;
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(encoder.encode(body).byteLength);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = encoder.encode(body).byteLength;
  const xrefEntries = offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
    .join("\n");
  body +=
    `xref\n0 ${objects.length + 1}\n` +
    `0000000000 65535 f \n${xrefEntries}\n` +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return encoder.encode(body);
}

/** Builds a one-object-per-page PDF whose page N's text layer is
 * `pages[N-1]` — page numbers in the built document always match the
 * array, which is what the deep-link assertions rely on. */
export function makeTextPdf(pages: readonly string[]): Buffer {
  if (pages.length === 0) {
    throw new Error("makeTextPdf: at least one page");
  }

  // Object plan: 1 catalog, 2 page tree, 3 font, then per page i
  // (0-based): 4+2i = page, 5+2i = its content stream.
  const kidRefs = pages.map((_, i) => `${4 + 2 * i} 0 R`).join(" ");
  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [${kidRefs}] /Count ${pages.length} >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
  ];
  for (const [i, text] of pages.entries()) {
    const stream =
      text.length > 0
        ? `BT /F1 12 Tf 72 720 Td (${escapePdfText(text)}) Tj ET`
        : ``;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }

  return Buffer.from(assemblePdf(objects));
}
