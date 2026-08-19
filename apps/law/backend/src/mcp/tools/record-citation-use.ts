/**
 * record_citation_use — "we used this judgment in that matter, for
 * this proposition" (FR-CIT-001): the write that makes the firm's
 * library compound. The document id comes from a previous
 * find_documents/search_documents answer (ids ride the lines); the
 * pipeline enforces that it is a judgment-collection document the
 * caller can read, and that the caller works the using case.
 */

import { create } from "@bufbuild/protobuf";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallerIdentity } from "@stigmer/identity";
import { z } from "zod";
import { CitationUseSchema } from "../../gen/stigmer/law/citationuse/v1/citationuse_pb.js";
import { gated, textResult } from "../gate.js";
import { caseByFileNumber, type ToolDeps } from "./shared.js";

const NAME = "record_citation_use";

export function registerRecordCitationUse(
  server: McpServer,
  identity: CallerIdentity | undefined,
  deps: ToolDeps,
): string {
  server.registerTool(
    NAME,
    {
      description:
        "Record that a judgment from the firm's library was used in a matter, " +
        "and for what proposition — e.g. 'applied in CRL/2026/107 for " +
        "anticipatory bail'. Takes the judgment's document id (from a " +
        "find_documents or search_documents answer), the matter's file " +
        "number, and the proposition in the person's words. Read the entry " +
        "back and confirm before recording; the record is permanent.",
      inputSchema: {
        document_id: z
          .string()
          .min(1)
          .describe("The judgment document's id, from a previous documents answer."),
        file_number: z
          .string()
          .min(1)
          .describe("The firm's file number for the matter it was used in."),
        proposition: z
          .string()
          .min(1)
          .max(500)
          .describe("What it was used FOR, in the lawyer's words."),
      },
    },
    gated(NAME, identity, deps.resolveCallerIdentity, async (args, caller) => {
      const matter = await caseByFileNumber(deps.resources, caller.principal, args.file_number);
      const saved = await deps.resources.citationUses.invoke.create(
        create(CitationUseSchema, {
          spec: {
            documentId: args.document_id,
            caseId: matter.metadata?.id ?? "",
            proposition: args.proposition,
          },
        }),
        caller.principal,
      );
      return textResult(
        `Recorded: used in ${matter.spec?.fileNumber} for "${args.proposition}".`,
        {
          citation_use_id: saved.metadata?.id,
          document_id: args.document_id,
          case_id: matter.metadata?.id,
          file_number: matter.spec?.fileNumber,
        },
      );
    }),
  );
  return NAME;
}
