/**
 * case_story — "where does this matter stand?" (journey J6): the case's
 * facts, its diary (recent hearings with outcomes), open deadlines, and
 * the latest notes, in one answer. Membership-gated by the policy: a
 * non-member lawyer asking gets the denial sentence, not a redacted
 * story.
 */

import { create } from "@bufbuild/protobuf";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallerIdentity } from "@stigmer/identity";
import { z } from "zod";
import { ClientRole, ForumKind } from "../../gen/stigmer/law/case/v1/case_pb.js";
import {
  ListCaseActsRequestSchema,
  type CaseAct,
} from "../../gen/stigmer/law/caseact/v1/caseact_pb.js";
import { ListCaseNotesRequestSchema } from "../../gen/stigmer/law/casenote/v1/casenote_pb.js";
import type { CaseNote } from "../../gen/stigmer/law/casenote/v1/casenote_pb.js";
import {
  ListDeadlinesRequestSchema,
  type Deadline,
} from "../../gen/stigmer/law/deadline/v1/deadline_pb.js";
import {
  ListDocumentsRequestSchema,
  type Document,
} from "../../gen/stigmer/law/document/v1/document_pb.js";
import {
  ListHearingsRequestSchema,
  type Hearing,
} from "../../gen/stigmer/law/hearing/v1/hearing_pb.js";
import { countNoun, formatDate } from "../format.js";
import { gated, textResult } from "../gate.js";
import {
  caseByFileNumber,
  deadlineLine,
  documentLine,
  hearingLine,
  type ToolDeps,
} from "./shared.js";

const NAME = "case_story";

/** Enum → the word a lawyer says. */
function roleWord(role: ClientRole): string {
  const name = ClientRole[role] ?? "OTHER";
  return name.toLowerCase().replace(/_/g, " ");
}

function forumWord(kind: ForumKind): string {
  const name = ForumKind[kind] ?? "OTHER";
  return name.toLowerCase().replace(/_/g, " ");
}

export function registerCaseStory(
  server: McpServer,
  identity: CallerIdentity | undefined,
  deps: ToolDeps,
): string {
  server.registerTool(
    NAME,
    {
      description:
        "The full story of one matter by its firm file number: parties, forum " +
        "and stage, the next hearing, recent hearings with their outcomes (the " +
        "case diary), open deadlines, and the latest notes. Only case members " +
        "and partners can read a case's story.",
      inputSchema: {
        file_number: z
          .string()
          .min(1)
          .describe("The firm's file number for the matter, e.g. 'CS/2026/041'."),
      },
      annotations: { readOnlyHint: true },
    },
    gated(NAME, identity, deps.resolveCallerIdentity, async (args, caller) => {
      // Membership is decided HERE: get relays the policy's denial.
      const theCase = await caseByFileNumber(deps.resources, caller.principal, args.file_number);
      const caseId = theCase.metadata?.id ?? "";

      const [hearings, deadlines, notes, documents, acts] = await Promise.all([
        deps.resources.hearings.invoke.list(
          create(ListHearingsRequestSchema, { caseId, pageSize: 100 }),
          caller.principal,
        ),
        deps.resources.deadlines.invoke.list(
          create(ListDeadlinesRequestSchema, { caseId, openOnly: true, pageSize: 10 }),
          caller.principal,
        ),
        deps.resources.caseNotes.invoke.list(
          create(ListCaseNotesRequestSchema, { caseId, pageSize: 3 }),
          caller.principal,
        ),
        deps.resources.documents.invoke.list(
          create(ListDocumentsRequestSchema, { caseId, pageSize: 5 }),
          caller.principal,
        ),
        deps.resources.caseActs.invoke.list(
          create(ListCaseActsRequestSchema, { caseId, pageSize: 100 }),
          caller.principal,
        ),
      ]);

      const spec = theCase.spec;
      const parties = spec?.opposingParties.map((p) => p.name).join(", ") || "none recorded";
      const header = [
        `${spec?.fileNumber} — client is ${roleWord(spec?.clientRole ?? ClientRole.OTHER)}`,
        `vs ${parties}`,
        `at ${spec?.forum?.name ?? ""} (${forumWord(spec?.forum?.forumKind ?? ForumKind.OTHER)})`,
        spec?.stage ? `stage: ${spec.stage}` : "",
        spec?.courtCaseNumber ? `court no. ${spec.courtCaseNumber}` : "court number not assigned yet",
        theCase.status?.nextHearingDate
          ? `next hearing ${formatDate(theCase.status.nextHearingDate)}`
          : "NO next date on the board",
      ]
        .filter(Boolean)
        .join("\n");

      // The diary reads newest first in an answer; the list arrives date
      // ascending, so take the tail.
      const diary = (hearings.items as Hearing[])
        .slice(-5)
        .reverse()
        .map((h, i) => `${i + 1}. ${hearingLine(h)}`)
        .join("\n");

      const deadlineLines = (deadlines.items as Deadline[])
        .map((d, i) => `${i + 1}. ${deadlineLine(d)}`)
        .join("\n");

      const noteLines = (notes.items as CaseNote[])
        .map((n) => `- ${formatDate(isoDateOf(n))}: ${n.spec?.content ?? ""}`)
        .join("\n");

      const documentLines = (documents.items as Document[])
        .map((d, i) => `${i + 1}. ${documentLine(d)}`)
        .join("\n");

      // The statutory frame (FR-ACT-001): compact — one line per act,
      // sections inline, the way the FIR reads.
      const actLines = (acts.items as CaseAct[])
        .map(
          (a) =>
            `- ${a.spec?.act}${a.spec?.sections.length ? ` — ${a.spec.sections.join(", ")}` : ""}${a.spec?.note ? ` (${a.spec.note})` : ""}`,
        )
        .join("\n");

      const sections = [
        header,
        acts.items.length > 0
          ? `Acts & sections (${countNoun(acts.totalCount, "act")}):\n${actLines}`
          : "",
        diary ? `Recent hearings (newest first):\n${diary}` : "No hearings recorded yet.",
        deadlines.items.length > 0
          ? `Open deadlines (${countNoun(deadlines.totalCount, "deadline")}):\n${deadlineLines}`
          : "No open deadlines.",
        documents.items.length > 0
          ? `Documents on file (${countNoun(documents.totalCount, "document")}, newest first):\n${documentLines}`
          : "No documents on file yet.",
        notes.items.length > 0 ? `Latest notes:\n${noteLines}` : "",
      ].filter(Boolean);

      return textResult(sections.join("\n\n"), {
        case_id: caseId,
        file_number: spec?.fileNumber,
        next_hearing_date: theCase.status?.nextHearingDate,
        open_deadlines: Number(deadlines.totalCount),
        hearings_recorded: Number(hearings.totalCount),
        document_count: theCase.status?.documentCount ?? 0,
      });
    }),
  );
  return NAME;
}

/** A note's calendar day from its creation instant (display only). */
function isoDateOf(note: CaseNote): string | undefined {
  const seconds = note.metadata?.createdAt?.seconds;
  if (seconds === undefined) return undefined;
  return new Date(Number(seconds) * 1000).toISOString().slice(0, 10);
}
