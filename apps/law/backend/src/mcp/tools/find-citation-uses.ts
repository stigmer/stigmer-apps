/**
 * find_citation_uses — the firm's reliance trail (FR-CIT-001): "what
 * did we rely on in this matter?" (by file number), "has this
 * precedent worked for us before?" (by document id), or the recent
 * trail across the caller's visible cases (no arguments). The
 * RECOMMENDATION flow rides this + search_documents over the judgment
 * collection: retrieval here, reasoning in the agent — no machinery
 * guesses relevance (DD-011 D3).
 */

import { create } from "@bufbuild/protobuf";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallerIdentity } from "@stigmer/identity";
import { z } from "zod";
import {
  ListCitationUsesRequestSchema,
  type CitationUse,
} from "../../gen/stigmer/law/citationuse/v1/citationuse_pb.js";
import { countNoun } from "../format.js";
import { gated, textResult } from "../gate.js";
import { caseByFileNumber, type ToolDeps } from "./shared.js";

const NAME = "find_citation_uses";

/** One use as an answer line: the reliance fact first, ids last. */
function useLine(use: CitationUse): string {
  return (
    `${use.status?.documentFileName ?? "?"} — used in ${use.status?.caseFileNumber ?? "?"} ` +
    `for "${use.spec?.proposition ?? ""}" · document id ${use.spec?.documentId} · id ${use.metadata?.id}`
  );
}

export function registerFindCitationUses(
  server: McpServer,
  identity: CallerIdentity | undefined,
  deps: ToolDeps,
): string {
  server.registerTool(
    NAME,
    {
      description:
        "The firm's citation reliance trail: which judgments were used where, " +
        "and for what proposition. Filter by a matter's file number, by a " +
        "judgment's document id (from a documents answer), by both, or " +
        "neither for the recent trail across the matters the caller can see. " +
        "For 'find me a citation ABOUT X', combine this with " +
        "search_documents on the judgment collection.",
      inputSchema: {
        file_number: z
          .string()
          .optional()
          .describe("Narrow to one matter's citations, by the firm's file number."),
        document_id: z
          .string()
          .optional()
          .describe("Narrow to everywhere one judgment was used."),
      },
      annotations: { readOnlyHint: true },
    },
    gated(NAME, identity, deps.resolveCallerIdentity, async (args, caller) => {
      let caseId = "";
      let fileNumber: string | undefined;
      if (args.file_number) {
        const matter = await caseByFileNumber(deps.resources, caller.principal, args.file_number);
        caseId = matter.metadata?.id ?? "";
        fileNumber = matter.spec?.fileNumber;
      }
      const uses = await deps.resources.citationUses.invoke.list(
        create(ListCitationUsesRequestSchema, {
          caseId,
          documentId: args.document_id ?? "",
          pageSize: 20,
        }),
        caller.principal,
      );
      if (uses.items.length === 0) {
        return textResult(
          fileNumber
            ? `No citation uses recorded on ${fileNumber} yet.`
            : "No citation uses recorded yet — record one with record_citation_use " +
                "after relying on a judgment from the library.",
        );
      }
      const lines = (uses.items as CitationUse[])
        .map((u, i) => `${i + 1}. ${useLine(u)}`)
        .join("\n");
      return textResult(
        `Citation uses (${countNoun(uses.totalCount, "use")}, newest first):\n${lines}`,
        {
          total: Number(uses.totalCount),
          uses: (uses.items as CitationUse[]).map((u) => ({
            id: u.metadata?.id,
            document_id: u.spec?.documentId,
            document_file_name: u.status?.documentFileName,
            file_number: u.status?.caseFileNumber,
            proposition: u.spec?.proposition,
          })),
        },
      );
    }),
  );
  return NAME;
}
