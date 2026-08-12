/**
 * find_documents — the document register question (FR-DOC-004): what
 * papers are on a matter's file, or what is in the firm-wide judgment
 * collection (FR-DOC-002). Metadata only — reading what is INSIDE a
 * document is read_document/search_documents territory. The two scopes
 * mirror the Document List operation's two sanctioned shapes exactly;
 * the tool adds no third.
 */

import { create } from "@bufbuild/protobuf";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallerIdentity } from "@stigmer/identity";
import { z } from "zod";
import {
  DocumentCategory,
  ListDocumentsRequestSchema,
  type Document,
} from "../../gen/stigmer/law/document/v1/document_pb.js";
import { countNoun } from "../format.js";
import { errorResult, gated, textResult } from "../gate.js";
import {
  caseByFileNumber,
  documentLine,
  documentRecord,
  fileNumbersByCaseId,
  type ToolDeps,
} from "./shared.js";

const NAME = "find_documents";

/** The category words a lawyer types, bound to the wire enum here so a
 * typo is a schema refusal the model can correct, never a misfiled
 * lookup. */
const CATEGORIES = [
  "pleading",
  "application",
  "evidence",
  "order_judgment",
  "correspondence",
  "vakalatnama",
  "judgment",
  "other",
] as const;
const WIRE_CATEGORY: Record<(typeof CATEGORIES)[number], DocumentCategory> = {
  pleading: DocumentCategory.PLEADING,
  application: DocumentCategory.APPLICATION,
  evidence: DocumentCategory.EVIDENCE,
  order_judgment: DocumentCategory.ORDER_JUDGMENT,
  correspondence: DocumentCategory.CORRESPONDENCE,
  vakalatnama: DocumentCategory.VAKALATNAMA,
  judgment: DocumentCategory.JUDGMENT,
  other: DocumentCategory.OTHER,
};

export function registerFindDocuments(
  server: McpServer,
  identity: CallerIdentity | undefined,
  deps: ToolDeps,
): string {
  server.registerTool(
    NAME,
    {
      description:
        "List the documents on a matter's file by its file number (newest " +
        "first, optionally narrowed to one category), or — with category " +
        "'judgment' and no file number — the firm's whole judgment " +
        "collection across the caller's visible cases. Answers include " +
        "each document's id.",
      inputSchema: {
        file_number: z
          .string()
          .min(1)
          .optional()
          .describe("The firm's file number for the matter, e.g. 'CS/2026/041'."),
        category: z
          .enum(CATEGORIES)
          .optional()
          .describe(
            "Narrow to one kind of paper. 'judgment' alone (no file number) " +
              "lists the firm-wide judgment collection.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    gated(NAME, identity, deps.resolveCallerIdentity, async (args, caller) => {
      if (!args.file_number && args.category !== "judgment") {
        // The List operation's own rule, said in tool terms before a
        // round trip is spent discovering it.
        return errorResult(
          "Give a matter's file number, or ask for category 'judgment' to " +
            "see the firm-wide judgment collection.",
        );
      }

      let caseId = "";
      if (args.file_number) {
        // NOT_FOUND (and the membership denial) relay verbatim through
        // the gate.
        caseId = (await caseByFileNumber(deps.resources, caller.principal, args.file_number))
          .metadata?.id ?? "";
      }

      const page = await deps.resources.documents.invoke.list(
        create(ListDocumentsRequestSchema, {
          caseId,
          category: args.category ? WIRE_CATEGORY[args.category] : DocumentCategory.UNSPECIFIED,
          pageSize: 20,
        }),
        caller.principal,
      );
      const items = page.items as Document[];

      // The firm-wide view spans cases, so every line names its matter.
      const fileNumberOf = args.file_number
        ? () => undefined
        : await fileNumbersByCaseId(deps.store, items.map((d) => d.spec?.caseId ?? ""));

      const what = args.category ? `${args.category.replace(/_/g, " ")} document` : "document";
      const where = args.file_number
        ? `on ${args.file_number.trim()}`
        : "in the firm's collection";
      const headline = `${countNoun(page.totalCount, what)} ${where}`;

      if (items.length === 0) {
        return textResult(`${headline}.`);
      }
      const lines = items.map(
        (d, i) => `${i + 1}. ${documentLine(d, fileNumberOf(d.spec?.caseId))}`,
      );
      const more =
        page.totalCount > BigInt(items.length)
          ? `\n(showing the ${items.length} newest)`
          : "";
      return textResult(`${headline}:\n${lines.join("\n")}${more}`, {
        documents: items.map((d) => documentRecord(d, fileNumberOf(d.spec?.caseId))),
        total_count: Number(page.totalCount),
      });
    }),
  );
  return NAME;
}
