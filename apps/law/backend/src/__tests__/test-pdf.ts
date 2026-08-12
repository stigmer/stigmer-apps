/**
 * A minimal, valid, text-layer PDF builder for extraction tests — one
 * Helvetica text run per page, correct xref offsets, no dependencies.
 * pdfjs parses it like any born-digital filing; what it can NEVER be is
 * a scan, so scan/garbage fixtures stay separate (raw bytes).
 */

const encoder = new TextEncoder();

function escapePdfText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Builds a one-object-per-page PDF whose page N's text layer is
 * `pages[N-1]`. An empty string yields a blank page — page numbers in
 * the built document always match the array, which is what the
 * citation tests rely on. */
export function makeTextPdf(pages: readonly string[]): Uint8Array {
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
