/**
 * search_documents — "where have we said this before?" (FR-DOC-004):
 * literal text search over the extracted pages of the caller's visible
 * documents, each hit cited the way a lawyer cites — file number,
 * document, PAGE. The search itself is the DocumentPage pipeline's
 * Search operation (visibility filtered inside the store query); this
 * tool only windows snippets and renders lines.
 *
 * Honesty rules: matching is literal substring (no stemming — the
 * description tells the model to try another word, not this tool
 * again with the same one), and the scan sentence is
 * deployment-conditional (DD-009): where the OCR sweep runs, scans
 * become searchable once read; where it doesn't, they are not
 * searchable — the description says whichever is true, so the
 * assistant can say so.
 */

import { create } from "@bufbuild/protobuf";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallerIdentity } from "@stigmer/identity";
import { z } from "zod";
import type { Case } from "../../gen/stigmer/law/case/v1/case_pb.js";
import type { Document } from "../../gen/stigmer/law/document/v1/document_pb.js";
import {
  type DocumentPage,
  SearchDocumentPagesRequestSchema,
  TextSource,
} from "../../gen/stigmer/law/documentpage/v1/documentpage_pb.js";
import { countNoun } from "../format.js";
import { gated, textResult } from "../gate.js";
import { caseByFileNumber, type ToolDeps } from "./shared.js";
import { snippetAround } from "./snippet.js";

const NAME = "search_documents";

export function registerSearchDocuments(
  server: McpServer,
  identity: CallerIdentity | undefined,
  deps: ToolDeps,
): string {
  server.registerTool(
    NAME,
    {
      description:
        "Search the text of the firm's documents (the pages the system has " +
        "extracted) for an exact word or phrase — across every case the " +
        "caller can see AND the firm library (bare acts, standalone " +
        "citations), or within one matter. This is how to answer 'what " +
        "does Section 420 say?': search the act's text, then read the " +
        "cited page. Matching is literal — if a word finds nothing, try a " +
        "synonym or a shorter root (e.g. 'limitation' not 'time-barred'). " +
        (deps.ocrEnabled
          ? "Scanned documents and photos become searchable a few minutes " +
            "after upload, once the system has read them. "
          : "Scanned documents and photos are not searchable yet. ") +
        "Each hit cites the matter, the document, and " +
        "the page, and includes the document's id.",
      inputSchema: {
        query: z
          .string()
          .min(2)
          .max(200)
          .describe("The exact word or phrase to find, e.g. 'limitation' or 'arbitration agreement'."),
        file_number: z
          .string()
          .min(1)
          .optional()
          .describe("Narrow to one matter by its file number, e.g. 'CS/2026/041'."),
      },
      annotations: { readOnlyHint: true },
    },
    gated(NAME, identity, deps.resolveCallerIdentity, async (args, caller) => {
      let caseId = "";
      if (args.file_number) {
        // NOT_FOUND and the membership denial relay verbatim.
        caseId = (await caseByFileNumber(deps.resources, caller.principal, args.file_number))
          .metadata?.id ?? "";
      }

      const { items } = await deps.resources.documentPages.invoke.search(
        create(SearchDocumentPagesRequestSchema, { query: args.query, caseId }),
        caller.principal,
      );
      const pages = items as DocumentPage[];

      const where = args.file_number
        ? `on ${args.file_number.trim()}`
        : "across your visible cases and the firm library";
      if (pages.length === 0) {
        return textResult(
          `No document pages match "${args.query}" ${where}. Matching is ` +
            `exact — a different word may find it; ` +
            (deps.ocrEnabled
              ? `recently uploaded scans may still be being read.`
              : `scanned documents are not searchable yet.`),
        );
      }

      // One bulk lookup per referenced kind for the citation facts —
      // never an N+1 (the shared-store display rule, DD-A4).
      const documents = (await deps.store.getByIds("Document", [
        ...new Set(pages.map((p) => p.spec?.documentId ?? "")),
      ])) as Map<string, Document>;
      const cases = (await deps.store.getByIds("Case", [
        ...new Set(pages.map((p) => p.spec?.caseId ?? "")),
      ])) as Map<string, Case>;

      const hits = pages.map((page) => {
        const document = documents.get(page.spec?.documentId ?? "");
        // A case-less page is firm-library material (FR-DOC-005) —
        // cite the library where a matter's number would go.
        const fileNumber = page.spec?.caseId
          ? (cases.get(page.spec.caseId)?.spec?.fileNumber ?? "")
          : "Firm library";
        return {
          snippet: snippetAround(page.spec?.text ?? "", args.query),
          file_name: document?.spec?.fileName ?? "(unknown document)",
          file_number: fileNumber,
          page: page.spec?.page ?? 0,
          document_id: page.spec?.documentId,
          // Terse by design — read_document's page label carries the
          // full recognition caution (DD-009).
          from_scan: page.spec?.source === TextSource.OCR || undefined,
        };
      });

      const lines = hits.map(
        (h, i) =>
          `${i + 1}. "${h.snippet}"\n   — ${h.file_name}, page ${h.page}${h.from_scan ? " (from a scan)" : ""} · ${h.file_number} · id ${h.document_id}`,
      );
      return textResult(
        `${countNoun(hits.length, "matching page")} ${where} (top matches):\n${lines.join("\n")}`,
        { hits, query: args.query },
      );
    }),
  );
  return NAME;
}
