/**
 * add_case_act — an Act (with its sections) onto a matter's statutory
 * frame, from the phone (FR-ACT-001): the "reading the FIR in the
 * corridor" moment. MANUAL by contract (the client's own decision):
 * the human names the acts; this verb only records them, through the
 * same create pipeline the web app uses, attributed to the verified
 * caller.
 */

import { create } from "@bufbuild/protobuf";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallerIdentity } from "@stigmer/identity";
import { z } from "zod";
import { CaseActSchema } from "../../gen/stigmer/law/caseact/v1/caseact_pb.js";
import { gated, textResult } from "../gate.js";
import { caseByFileNumber, type ToolDeps } from "./shared.js";

const NAME = "add_case_act";

export function registerAddCaseAct(
  server: McpServer,
  identity: CallerIdentity | undefined,
  deps: ToolDeps,
): string {
  server.registerTool(
    NAME,
    {
      description:
        "Add an Act with its sections to a matter's statutory frame, by the " +
        "firm's file number — e.g. act 'IPC' with sections ['420','468']. " +
        "Manual entry is the rule: record exactly the acts the person names, " +
        "read the entry back and confirm before adding. Never infer or " +
        "suggest acts as if they were on the frame.",
      inputSchema: {
        file_number: z
          .string()
          .min(1)
          .describe("The firm's file number for the matter, e.g. 'CS/2026/041'."),
        act: z
          .string()
          .min(1)
          .max(200)
          .describe("The Act's name as the firm cites it, e.g. 'IPC' or 'NI Act'."),
        sections: z
          .array(z.string().min(1).max(50))
          .max(100)
          .optional()
          .describe("The sections invoked under this Act, e.g. ['420', '34 r/w 120B']."),
        note: z
          .string()
          .max(1000)
          .optional()
          .describe("Why this act is on the frame, in the person's words."),
      },
      // No destructiveHint (additive; corrections are edits in the web
      // app) — an untrue hint would approval-gate this tool into a
      // silent skip on the unattended WhatsApp surface.
    },
    gated(NAME, identity, deps.resolveCallerIdentity, async (args, caller) => {
      const matter = await caseByFileNumber(deps.resources, caller.principal, args.file_number);
      const saved = await deps.resources.caseActs.invoke.create(
        create(CaseActSchema, {
          spec: {
            caseId: matter.metadata?.id ?? "",
            act: args.act,
            sections: args.sections ?? [],
            note: args.note ?? "",
          },
        }),
        caller.principal,
      );
      const sections = saved.spec?.sections.length
        ? ` — sections ${saved.spec.sections.join(", ")}`
        : "";
      return textResult(
        `${saved.spec?.act}${sections} added to ${matter.spec?.fileNumber}'s frame. ` +
          `Corrections happen in the web app's Acts tab.`,
        {
          case_act_id: saved.metadata?.id,
          case_id: matter.metadata?.id,
          file_number: matter.spec?.fileNumber,
        },
      );
    }),
  );
  return NAME;
}
