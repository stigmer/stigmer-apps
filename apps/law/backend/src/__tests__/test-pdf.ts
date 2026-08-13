/**
 * Minimal, valid, text-layer PDF builders for extraction tests — one
 * Helvetica text run per page, correct xref offsets, no dependencies.
 * pdfjs parses them like any born-digital filing; what they can NEVER
 * be is a scan, so scan/garbage fixtures stay separate (raw bytes).
 * makeNulGlyphPdf additionally models a broken ToUnicode map (the
 * live U+0000 poison pill — its own comment has the story).
 */

const encoder = new TextEncoder();

function escapePdfText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Serializes numbered objects plus the xref table and trailer — the
 * bookkeeping both builders below share. */
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

  return assemblePdf(objects);
}

/**
 * Builds a one-page PDF that models the LIVE poison-pill shape
 * (2026-08-13): a generator's broken ToUnicode map yields U+0000 from
 * the text layer. The font carries a ToUnicode CMap that maps '#'
 * (0x23) to U+0000, so pdfjs extracts a REAL NUL for every '#' in
 * `text` — Chrome's print-to-pdf does exactly this for glyphs its
 * ToUnicode table failed to map, and one such character is enough to
 * make the Postgres jsonb persist fail forever. Proven against pdfjs
 * in isolation before the fixture was adopted: without the extractor's
 * strip, the extracted page really contains \u0000.
 */
export function makeNulGlyphPdf(text: string): Uint8Array {
  const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CMapName /Broken-UCS def
/CMapType 2 def
1 begincodespacerange
<00> <FF>
endcodespacerange
1 beginbfchar
<23> <0000>
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
  const stream = `BT /F1 12 Tf 72 720 Td (${escapePdfText(text)}) Tj ET`;
  return assemblePdf([
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [4 0 R] /Count 1 >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`,
  ]);
}
