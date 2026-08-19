/**
 * attach_document — file a paper someone sent in the conversation into
 * a matter's case file; the "client WhatsApps the court order → it is
 * on the file" moment (FR-ASST-002's held-back verb, unblocked by
 * stigmer/stigmer#532: the runner now lists a presigned download URL
 * beside each attachment in the agent's context).
 *
 * The agent quotes that URL here; the backend fetches the bytes ITSELF
 * through the remote-fetch guard (the URL is model-written text — see
 * files/remote-fetch.ts for the threat model) and stores them through
 * the same document core the web upload rides, as the verified caller —
 * a paper filed over WhatsApp is byte-identical to one uploaded in the
 * browser, and the extraction sweep picks it up the same way.
 *
 * Order matters: resolve the matter (membership refusals relay from the
 * pipeline), pre-authorize Document/create, and only THEN fetch — an
 * unauthorized caller must never be able to point the firm's backend at
 * a URL.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Code, ConnectError } from "@connectrpc/connect";
import type { CallerIdentity } from "@stigmer/identity";
import { z } from "zod";
import { parseCategoryWord } from "../../domain/document/store-document.js";
import { gated, textResult } from "../gate.js";
import { caseByFileNumber, documentLine, documentRecord, type ToolDeps } from "./shared.js";

const NAME = "attach_document";

export function registerAttachDocument(
  server: McpServer,
  identity: CallerIdentity | undefined,
  deps: ToolDeps,
): string {
  server.registerTool(
    NAME,
    {
      description:
        "File a document someone sent in this conversation into a matter's " +
        "case file, OR into the firm library (to_library: true — for " +
        "standalone citations, category 'judgment' only). Pass the " +
        "download URL listed beside the attachment in your context — never " +
        "retype or invent one. Documents are permanent records — confirm " +
        "the destination, file name, and category before filing.",
      inputSchema: {
        file_number: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The firm's file number for the matter, e.g. 'CS/2026/041'. " +
              "Omit when filing to the library (to_library).",
          ),
        to_library: z
          .boolean()
          .optional()
          .describe(
            "File to the FIRM LIBRARY instead of a matter: public-record " +
              "material (a standalone citation) that belongs to no case. " +
              "Category 'judgment' only.",
          ),
        download_url: z
          .string()
          .min(1)
          .describe(
            "The attachment's download URL, copied exactly from the input-files " +
              "listing in your context.",
          ),
        file_name: z
          .string()
          .min(1)
          .max(255)
          .describe("The name the paper should carry on the file, e.g. 'court-order.jpg'."),
        category: z
          .string()
          .optional()
          .describe(
            "One of: pleading, application, evidence, order_judgment, " +
              "correspondence, vakalatnama, judgment, other. Omit only " +
              "when the person cannot say what the paper is.",
          ),
        hearing_id: z
          .string()
          .optional()
          .describe("A hearing id from a previous read, when the paper belongs to one."),
        citation_title: z
          .string()
          .max(300)
          .optional()
          .describe(
            "Library filings only: the judgment's case name as the firm " +
              "cites it (e.g. 'Arnesh Kumar vs State of Bihar'). Ask for " +
              "it — a shelf entry named after a PDF file helps nobody; " +
              "omitted, the file name stands in until someone refines it.",
          ),
        citation_court: z
          .string()
          .max(200)
          .optional()
          .describe("Library filings only: the court, as cited."),
        citation_year: z
          .number()
          .int()
          .min(0)
          .max(2100)
          .optional()
          .describe("Library filings only: the judgment's year."),
        citation_string: z
          .string()
          .max(200)
          .optional()
          .describe(
            "Library filings only: the reporter or neutral citation, e.g. " +
              "'AIR 2014 SC 2756'.",
          ),
      },
      // No destructiveHint (filing adds a record, nothing is lost) — and
      // an untrue hint would approval-gate this tool into a silent skip
      // on the unattended WhatsApp surface (the add_case_note precedent).
    },
    gated(NAME, identity, deps.resolveCallerIdentity, async (args, caller) => {
      // Exactly one destination: a matter, or the firm library.
      if (!args.to_library && !args.file_number) {
        throw new ConnectError(
          "Give the matter's file number, or set to_library for " +
            "public-record material (standalone citations)",
          Code.InvalidArgument,
        );
      }
      if (args.to_library && args.file_number) {
        throw new ConnectError(
          "to_library and file_number contradict each other — a paper is " +
            "filed to a matter OR to the firm library",
          Code.InvalidArgument,
        );
      }
      const matter = args.file_number
        ? await caseByFileNumber(deps.resources, caller.principal, args.file_number)
        : undefined;
      const category = parseCategoryWord(args.category ?? "");

      // The role gate, before any outbound byte moves (the pipeline
      // authorizes again at create — same arrangement as the upload
      // route's pre-check before the body is read).
      const decision = await deps.policy.authorize({
        caller: caller.principal,
        kind: "Document",
        operation: "create",
        resource: undefined,
      });
      if (!decision.allow) {
        throw new ConnectError(decision.reason, Code.PermissionDenied);
      }

      const fetched = await deps.fetchDocument(args.download_url);
      const document = await deps.storeDocument(
        {
          // undefined = the firm library; the pipeline's libraryIntegrity
          // step enforces the library-category rule with its own
          // user-facing sentence.
          caseId: matter?.metadata?.id,
          fileName: args.file_name,
          mimeType: fetched.mimeType,
          bytes: fetched.bytes,
          category,
          hearingId: args.hearing_id,
          citation: args.to_library
            ? {
                title: args.citation_title,
                court: args.citation_court,
                year: args.citation_year,
                citation: args.citation_string,
              }
            : undefined,
        },
        caller.principal,
      );

      return textResult(
        `Filed: ${documentLine(document, matter?.spec?.fileNumber)}`,
        documentRecord(document, matter?.spec?.fileNumber),
      );
    }),
  );
  return NAME;
}
