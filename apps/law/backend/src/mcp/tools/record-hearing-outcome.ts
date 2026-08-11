/**
 * record_hearing_outcome — the capture moment (journey J3, FR-HEAR-002):
 * "CS 142 adjourned to 12 Sep for evidence" becomes a recorded outcome
 * and, when a next date is given, the auto-scheduled next hearing — in
 * one tool call, exactly the single write path the web app uses.
 *
 * The hearing is found by the case's file number: the one awaiting
 * outcome whose date is not in the future. Ambiguity refuses and lists
 * the candidates with their ids (the agent retries with hearing_id) —
 * never a guess, because a guessed diary entry is a corrupted diary.
 */

import { create } from "@bufbuild/protobuf";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallerIdentity } from "@stigmer/identity";
import { z } from "zod";
import { todayInFirmTimezone } from "../../domain/firm-clock.js";
import {
  ListHearingsRequestSchema,
  OutcomeKind,
  RecordOutcomeRequestSchema,
  type Hearing,
} from "../../gen/stigmer/law/hearing/v1/hearing_pb.js";
import { formatDate, formatOutcome } from "../format.js";
import { errorResult, gated, textResult } from "../gate.js";
import { caseByFileNumber, hearingLine, type ToolDeps } from "./shared.js";

const NAME = "record_hearing_outcome";

const OUTCOMES = [
  "adjourned",
  "heard",
  "orders_reserved",
  "order_pronounced",
  "not_listed",
  "not_reached",
  "other",
] as const;

const WIRE_OUTCOME: Record<(typeof OUTCOMES)[number], OutcomeKind> = {
  adjourned: OutcomeKind.ADJOURNED,
  heard: OutcomeKind.HEARD,
  orders_reserved: OutcomeKind.ORDERS_RESERVED,
  order_pronounced: OutcomeKind.ORDER_PRONOUNCED,
  not_listed: OutcomeKind.NOT_LISTED,
  not_reached: OutcomeKind.NOT_REACHED,
  other: OutcomeKind.OTHER,
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function registerRecordHearingOutcome(
  server: McpServer,
  identity: CallerIdentity | undefined,
  deps: ToolDeps,
): string {
  server.registerTool(
    NAME,
    {
      description:
        "Record what happened at a hearing: the outcome (adjourned, heard, " +
        "orders reserved, order pronounced, not listed, not reached, other), " +
        "notes, and optionally the next date — which schedules the next " +
        "hearing automatically. Finds the hearing from the case's file " +
        "number; pass hearing_id only when asked to disambiguate. A recorded " +
        "outcome is permanent.",
      inputSchema: {
        file_number: z
          .string()
          .min(1)
          .describe("The firm's file number for the matter, e.g. 'CS/2026/041'."),
        outcome: z.enum(OUTCOMES).describe("What happened at the hearing."),
        notes: z.string().max(5000).optional().describe("What happened, in the caller's words."),
        next_date: z
          .string()
          .regex(ISO_DATE)
          .optional()
          .describe("The next hearing date as YYYY-MM-DD, when the court gave one."),
        next_purpose: z
          .string()
          .max(200)
          .optional()
          .describe("What the next listing is for, e.g. 'evidence'."),
        hearing_id: z
          .string()
          .min(1)
          .optional()
          .describe("Only when more than one hearing awaits an outcome: the id to record against."),
      },
      annotations: { readOnlyHint: false },
    },
    gated(NAME, identity, deps.resolveCallerIdentity, async (args, caller) => {
      const theCase = await caseByFileNumber(deps.resources, caller.principal, args.file_number);
      const caseId = theCase.metadata?.id ?? "";

      let hearingId = args.hearing_id;
      if (!hearingId) {
        // The natural target: hearings awaiting an outcome whose date
        // has arrived (today included — recording happens post-court).
        const { items } = await deps.resources.hearings.invoke.list(
          create(ListHearingsRequestSchema, { caseId, pageSize: 100 }),
          caller.principal,
        );
        const today = todayInFirmTimezone();
        const awaiting = (items as Hearing[]).filter(
          (h) =>
            (h.status?.outcomeKind ?? OutcomeKind.UNSPECIFIED) === OutcomeKind.UNSPECIFIED &&
            (h.spec?.date ?? "") <= today,
        );
        if (awaiting.length === 0) {
          return errorResult(
            `No hearing on ${args.file_number.trim()} is awaiting an outcome. ` +
              `If this was an unlisted appearance, schedule the hearing first.`,
          );
        }
        if (awaiting.length > 1) {
          const candidates = awaiting.map((h) => hearingLine(h)).join("\n");
          return errorResult(
            `More than one hearing on ${args.file_number.trim()} awaits an outcome — ` +
              `record against which?\n${candidates}\nCall again with hearing_id.`,
          );
        }
        hearingId = awaiting[0]?.metadata?.id ?? "";
      }

      const result = await deps.resources.hearings.invoke.recordOutcome(
        create(RecordOutcomeRequestSchema, {
          id: hearingId,
          outcomeKind: WIRE_OUTCOME[args.outcome],
          outcomeNotes: args.notes ?? "",
          nextDate: args.next_date,
          nextPurpose: args.next_purpose,
        }),
        caller.principal,
      );

      const recorded = `Recorded: ${args.file_number.trim()} ${formatOutcome(
        WIRE_OUTCOME[args.outcome],
      )} on ${formatDate(result.hearing?.spec?.date)}.`;
      const next = result.nextHearing
        ? ` Next hearing scheduled for ${formatDate(result.nextHearing.spec?.date)}${
            result.nextHearing.spec?.purpose ? ` (${result.nextHearing.spec.purpose})` : ""
          }.`
        : " No next date given — the matter will show under 'no next date' until one is scheduled.";
      return textResult(recorded + next, {
        hearing_id: result.hearing?.metadata?.id,
        next_hearing_id: result.nextHearing?.metadata?.id,
        next_hearing_date: result.nextHearing?.spec?.date,
      });
    }),
  );
  return NAME;
}
