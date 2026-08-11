/**
 * add_case_note — an append-only note on a matter, from the phone; the
 * "walking out of the hearing" moment. The note lands through the SAME
 * create pipeline the web app uses, attributed to the verified caller —
 * a note added over WhatsApp is byte-identical to one added in the
 * browser (the acceptance suite pins this).
 */

import { create } from "@bufbuild/protobuf";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallerIdentity } from "@stigmer/identity";
import { z } from "zod";
import { CaseNoteSchema } from "../../gen/stigmer/law/casenote/v1/casenote_pb.js";
import { gated, textResult } from "../gate.js";
import { caseByFileNumber, type ToolDeps } from "./shared.js";

const NAME = "add_case_note";

export function registerAddCaseNote(
  server: McpServer,
  identity: CallerIdentity | undefined,
  deps: ToolDeps,
): string {
  server.registerTool(
    NAME,
    {
      description:
        "Add a note to a matter by its firm file number. Notes are permanent " +
        "case records (append-only, attributed, up to 5000 characters) — read " +
        "the note back and confirm before adding it.",
      inputSchema: {
        file_number: z
          .string()
          .min(1)
          .describe("The firm's file number for the matter, e.g. 'CS/2026/041'."),
        note: z
          .string()
          .min(1)
          .max(5000)
          .describe("The note's text, as the person dictated it."),
      },
      // No destructiveHint (append-only, nothing is lost) — and an
      // untrue hint would approval-gate this tool into a silent skip on
      // the unattended WhatsApp surface.
    },
    gated(NAME, identity, deps.resolveCallerIdentity, async (args, caller) => {
      const matter = await caseByFileNumber(deps.resources, caller.principal, args.file_number);
      const saved = await deps.resources.caseNotes.invoke.create(
        create(CaseNoteSchema, {
          spec: { caseId: matter.metadata?.id ?? "", content: args.note },
        }),
        caller.principal,
      );
      return textResult(
        `Noted on ${matter.spec?.fileNumber} — recorded under your name.`,
        {
          note_id: saved.metadata?.id,
          case_id: matter.metadata?.id,
          file_number: matter.spec?.fileNumber,
        },
      );
    }),
  );
  return NAME;
}
