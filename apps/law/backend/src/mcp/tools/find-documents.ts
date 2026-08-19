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
import type { Citation } from "../../gen/stigmer/law/citation/v1/citation_pb.js";
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
        "first, optionally narrowed to one category); or — with no file " +
        "number — the firm-wide judgment collection: category 'judgment' " +
        "answers matters + the firm library together. Answers include " +
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
          "Give a matter's file number, or ask for category 'judgment' " +
            "(the firm's judgment collection).",
        );
      }

      let caseId = "";
      if (args.file_number) {
        // NOT_FOUND (and the membership denial) relay verbatim through
        // the gate.
        caseId = (await caseByFileNumber(deps.resources, caller.principal, args.file_number))
          .metadata?.id ?? "";
      }

      const category = args.category
        ? WIRE_CATEGORY[args.category]
        : DocumentCategory.UNSPECIFIED;
      const listPage = (init: { caseId?: string; libraryOnly?: boolean }) =>
        deps.resources.documents.invoke.list(
          create(ListDocumentsRequestSchema, {
            caseId: init.caseId ?? "",
            libraryOnly: init.libraryOnly ?? false,
            category,
            pageSize: 20,
          }),
          caller.principal,
        );

      // The judgment collection spans BOTH piles (FR-DOC-005): matters
      // and the firm library — two bounded pages interleaved newest
      // first, never offset-spliced (suggestion-list semantics; the
      // "(showing …)" line stays honest). A named matter is one pile
      // by definition.
      let items: Document[];
      let totalCount: bigint;
      if (!args.file_number && args.category === "judgment") {
        const [onMatters, inLibrary] = await Promise.all([
          listPage({}),
          listPage({ libraryOnly: true }),
        ]);
        items = ([...onMatters.items, ...inLibrary.items] as Document[])
          .sort(
            (a, b) =>
              Number(b.metadata?.createdAt?.seconds ?? 0n) -
              Number(a.metadata?.createdAt?.seconds ?? 0n),
          )
          .slice(0, 20);
        totalCount = onMatters.totalCount + inLibrary.totalCount;
      } else {
        const page = await listPage({ caseId });
        items = page.items as Document[];
        totalCount = page.totalCount;
      }

      // The firm-wide views span cases, so every line names its matter
      // (documentLine says "Firm library" where a document has none).
      const fileNumberOf = args.file_number
        ? () => undefined
        : await fileNumbersByCaseId(deps.store, items.map((d) => d.spec?.caseId ?? ""));

      // Shelf entries answer with their IDENTITY, not a bare file name
      // (DD-012 cross-surface coherence): one bulk lookup on the
      // Citation companion for the page's case-less rows.
      const shelfIds = items
        .filter((d) => !d.spec?.caseId)
        .map((d) => d.metadata?.id ?? "")
        .filter(Boolean);
      const identityOf = new Map<string, Citation>();
      if (shelfIds.length > 0) {
        const entries = await deps.store.list("Citation", {
          limit: shelfIds.length,
          offset: 0,
          filter: { documentId: { in: shelfIds } },
        });
        for (const entry of entries.items as Citation[]) {
          identityOf.set(entry.spec?.documentId ?? "", entry);
        }
      }
      const identitySuffix = (d: Document): string => {
        const entry = identityOf.get(d.metadata?.id ?? "");
        if (!entry?.spec) return "";
        const facts = [
          entry.spec.court,
          entry.spec.year > 0 ? String(entry.spec.year) : "",
          entry.spec.citation,
        ]
          .filter(Boolean)
          .join(", ");
        return ` — “${entry.spec.title}”${facts ? ` (${facts})` : ""}`;
      };

      const what = args.category ? `${args.category.replace(/_/g, " ")} document` : "document";
      const where = args.file_number
        ? `on ${args.file_number.trim()}`
        : "in the firm's collection";
      const headline = `${countNoun(totalCount, what)} ${where}`;

      if (items.length === 0) {
        return textResult(`${headline}.`);
      }
      const lines = items.map(
        (d, i) => `${i + 1}. ${documentLine(d, fileNumberOf(d.spec?.caseId))}${identitySuffix(d)}`,
      );
      const more =
        totalCount > BigInt(items.length) ? `\n(showing the ${items.length} newest)` : "";
      return textResult(`${headline}:\n${lines.join("\n")}${more}`, {
        documents: items.map((d) => documentRecord(d, fileNumberOf(d.spec?.caseId))),
        total_count: Number(totalCount),
      });
    }),
  );
  return NAME;
}
