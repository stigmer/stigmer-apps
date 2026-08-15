/**
 * Pure matching for the in-viewer find — the native viewer's Ctrl-F
 * equivalent, deliberately NOT a search engine. Case-insensitive
 * literal matching over the text layer, with ONE flexibility: any
 * whitespace in the query matches zero-or-more whitespace in the text.
 * That absorbs pdfjs's item boundaries (a visual space between two
 * positioned runs often has no character in the text layer at all), so
 * multi-word phrases still match. No diacritic folding, no
 * case-folding beyond toLowerCase semantics, no cross-language reach —
 * that is the SERVER's document search (DocumentPageService.Search,
 * ICU-collated); this box must never oversell.
 *
 * The page text is the text items' strings concatenated with NOTHING
 * between them — exactly the text-node content the pdfjs TextLayer
 * puts in the DOM. That identity is what makes a match's [start, end)
 * offsets convertible into DOM Ranges for highlighting (highlight.ts);
 * inserting separators here would silently shift every offset.
 */

export interface PageMatch {
  /** 1-based page number. */
  readonly page: number;
  /** Character offsets into the page's concatenated text. */
  readonly start: number;
  readonly end: number;
}

/** Concatenates text items EXACTLY as the TextLayer DOM will (see the
 * header — offset identity is the contract). */
export function buildPageText(items: readonly { readonly str: string }[]): string {
  return items.map((item) => item.str).join("");
}

/**
 * Compiles the query per the header's rules, or null when the query
 * has no searchable content. Unicode-aware ("v" flag would be stricter
 * than needed; "u" matches the codebase's existing regex posture).
 */
export function compileFindQuery(query: string): RegExp | null {
  const tokens = query.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  const escaped = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(escaped.join("\\s*"), "giu");
}

/** All matches of a compiled query on one page's text, in order. */
export function findMatchesOnPage(
  regex: RegExp,
  page: number,
  pageText: string,
): PageMatch[] {
  const matches: PageMatch[] = [];
  regex.lastIndex = 0;
  for (let m = regex.exec(pageText); m !== null; m = regex.exec(pageText)) {
    // A whitespace-only query compiles away above, but a degenerate
    // zero-length match must still not spin the loop forever.
    if (m[0].length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    matches.push({ page, start: m.index, end: m.index + m[0].length });
  }
  return matches;
}
