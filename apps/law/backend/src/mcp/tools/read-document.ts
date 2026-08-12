/**
 * read_document — open a document's extracted text (FR-DOC-004),
 * whole or one page at a time. The id comes from a previous
 * find_documents or search_documents answer (ids travel in answers —
 * shared.ts rule 2). Membership is the page pipeline's rule: whoever
 * cannot open the case is refused with the policy's sentence.
 *
 * The answer is BUDGETED, not paginated by rows: a chat message that
 * relays 200 pages helps nobody, so the tool returns whole pages until
 * the character budget is spent and says exactly where it stopped —
 * the model asks for a specific page to continue.
 */

import { create } from "@bufbuild/protobuf";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallerIdentity } from "@stigmer/identity";
import { z } from "zod";
import {
  ExtractionState,
  GetDocumentRequestSchema,
} from "../../gen/stigmer/law/document/v1/document_pb.js";
import {
  type DocumentPage,
  ListDocumentPagesRequestSchema,
} from "../../gen/stigmer/law/documentpage/v1/documentpage_pb.js";
import { errorResult, gated, textResult } from "../gate.js";
import type { ToolDeps } from "./shared.js";

const NAME = "read_document";

/** Whole pages are returned until this many characters are spent — a
 * generous reading-pane answer that still cannot flood a phone. */
const ANSWER_BUDGET_CHARS = 8000;

/** The honest sentence per unreadable state — the assistant relays
 * these rather than guessing at file contents. */
const UNREADABLE: Partial<Record<ExtractionState, string>> = {
  [ExtractionState.UNSPECIFIED]:
    "This document hasn't been read by the system yet — its text is usually " +
    "ready within a few minutes of upload. Try again shortly.",
  [ExtractionState.PENDING]:
    "This document hasn't been read by the system yet — its text is usually " +
    "ready within a few minutes of upload. Try again shortly.",
  [ExtractionState.NO_TEXT_LAYER]:
    "This document is a scan or photo, and I can't read those yet — I can " +
    "only tell you what's recorded about it (name, category, upload). A " +
    "person will need to open the file itself.",
  [ExtractionState.FAILED]:
    "This file couldn't be read by the system (it may be damaged or " +
    "password-protected). A person will need to open the file itself.",
};

export function registerReadDocument(
  server: McpServer,
  identity: CallerIdentity | undefined,
  deps: ToolDeps,
): string {
  server.registerTool(
    NAME,
    {
      description:
        "Read the text of one document by its id (from find_documents or " +
        "search_documents), optionally one page. Long documents return the " +
        "first pages up to a budget and say where they stopped — ask for a " +
        "specific page to continue. Scans, photos, and unreadable files are " +
        "reported honestly instead of guessed at.",
      inputSchema: {
        document_id: z
          .string()
          .min(1)
          .describe("The document's id from a previous answer, e.g. 'doc_01…'."),
        page: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Read just this page (1-based, as cited in search results)."),
      },
      annotations: { readOnlyHint: true },
    },
    gated(NAME, identity, deps.resolveCallerIdentity, async (args, caller) => {
      // Load the record first: NOT_FOUND and the membership denial both
      // relay verbatim, and the extraction state decides honesty below.
      const document = await deps.resources.documents.invoke.get(
        create(GetDocumentRequestSchema, { id: args.document_id }),
        caller.principal,
      );
      const state = document.status?.extraction ?? ExtractionState.UNSPECIFIED;
      const unreadable = UNREADABLE[state];
      if (unreadable) {
        return errorResult(`${document.spec?.fileName}: ${unreadable}`);
      }

      const pages = await deps.resources.documentPages.invoke.list(
        create(ListDocumentPagesRequestSchema, {
          documentId: args.document_id,
          pageSize: 100,
          pageOffset: args.page !== undefined ? args.page - 1 : 0,
        }),
        caller.principal,
      );
      const items = pages.items as DocumentPage[];
      const totalPages = Number(pages.totalCount);

      if (args.page !== undefined) {
        const wanted = items.find((p) => p.spec?.page === args.page);
        if (!wanted) {
          return errorResult(
            `${document.spec?.fileName} has ${totalPages} extracted pages — ` +
              `page ${args.page} does not exist.`,
          );
        }
        const text = wanted.spec?.text ?? "";
        const body = text.length > 0 ? text : "(this page carries no text)";
        return textResult(
          `${document.spec?.fileName}, page ${args.page} of ${totalPages}:\n${body}`,
          { document_id: args.document_id, page: args.page, total_pages: totalPages },
        );
      }

      // Whole pages within the budget, stopping honestly.
      const sections: string[] = [];
      let spent = 0;
      let lastIncluded = 0;
      for (const page of items) {
        const text = page.spec?.text ?? "";
        if (sections.length > 0 && spent + text.length > ANSWER_BUDGET_CHARS) break;
        sections.push(`[page ${page.spec?.page}]\n${text.length > 0 ? text : "(no text)"}`);
        spent += text.length;
        lastIncluded = page.spec?.page ?? lastIncluded;
        if (spent > ANSWER_BUDGET_CHARS) break;
      }
      const remainder =
        lastIncluded < totalPages
          ? `\n\n(showing pages 1–${lastIncluded} of ${totalPages} — ask for a specific page to continue)`
          : "";
      return textResult(
        `${document.spec?.fileName} (${totalPages} pages):\n\n${sections.join("\n\n")}${remainder}`,
        { document_id: args.document_id, total_pages: totalPages, pages_shown: lastIncluded },
      );
    }),
  );
  return NAME;
}
