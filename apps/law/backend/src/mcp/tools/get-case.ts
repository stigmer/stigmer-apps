/**
 * get_case — one matter, whole picture, one answer: the case facts, the
 * assigned lawyer's name, the open-task count, the document count, and
 * the most recent notes. Lawyers speak in case numbers; the proto's
 * GetCaseRequest resolves the natural key directly.
 */

import { create } from "@bufbuild/protobuf";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ChannelIdentity } from "@stigmer/identity";
import { GetUserRequestSchema } from "@stigmer/identity";
import { z } from "zod";
import { ListCaseNotesRequestSchema } from "../../gen/stigmer/law/casenote/v1/casenote_pb.js";
import {
  ListTasksRequestSchema,
  TaskListFilter,
  TaskListScope,
} from "../../gen/stigmer/law/task/v1/task_pb.js";
import { countNoun, formatDate } from "../format.js";
import { gated, textResult } from "../gate.js";
import { caseByNumber, type ToolDeps } from "./shared.js";

const NAME = "get_case";

export function registerGetCase(
  server: McpServer,
  identity: ChannelIdentity | undefined,
  deps: ToolDeps,
): string {
  server.registerTool(
    NAME,
    {
      description:
        "Everything about one case by its court case number: client, case " +
        "type, assigned lawyer, next hearing date, open tasks, documents on " +
        "file, and the most recent notes.",
      inputSchema: {
        case_number: z
          .string()
          .min(1)
          .describe("The court case number, exactly as the firm uses it."),
      },
      annotations: { readOnlyHint: true },
    },
    gated(NAME, identity, deps.resolveChannelIdentity, async (args, caller) => {
      const matter = await caseByNumber(deps.resources, caller.principal, args.case_number);
      const caseId = matter.metadata?.id as string;

      // Composition, not computation: every number below is a
      // server-computed total from the same pipelines the web app uses.
      const [lawyer, openTasks, notes] = await Promise.all([
        deps.resources.users.invoke.get(
          create(GetUserRequestSchema, { id: matter.spec?.assignedLawyerId ?? "" }),
          caller.principal,
        ),
        deps.resources.tasks.invoke.list(
          create(ListTasksRequestSchema, {
            caseId,
            filter: TaskListFilter.OPEN,
            scope: TaskListScope.FIRM,
            pageSize: 1,
          }),
          caller.principal,
        ),
        deps.resources.caseNotes.invoke.list(
          create(ListCaseNotesRequestSchema, { caseId, pageSize: 3 }),
          caller.principal,
        ),
      ]);

      const hearing = matter.spec?.nextHearingDate
        ? `next hearing ${formatDate(matter.spec.nextHearingDate)}`
        : "no hearing scheduled";
      const recentNotes =
        notes.items.length === 0
          ? "No notes yet."
          : notes.items
              .map((n) => `• ${n.spec?.content}`)
              .join("\n");

      return textResult(
        [
          `Case ${matter.spec?.caseNumber} — ${matter.spec?.clientName} (${matter.spec?.caseType})`,
          `Assigned to ${lawyer.spec?.name}; ${hearing}.`,
          `${countNoun(openTasks.totalCount, "open task")}, ${countNoun(matter.status?.documentCount ?? 0, "document")} on file.`,
          `Latest notes (newest first):\n${recentNotes}`,
          `id ${caseId}`,
        ].join("\n"),
        {
          case: {
            id: caseId,
            case_number: matter.spec?.caseNumber,
            client_name: matter.spec?.clientName,
            case_type: matter.spec?.caseType,
            assigned_lawyer: lawyer.spec?.name,
            next_hearing_date: matter.spec?.nextHearingDate,
            open_task_count: Number(openTasks.totalCount),
            document_count: matter.status?.documentCount ?? 0,
          },
          recent_notes: notes.items.map((n) => ({
            content: n.spec?.content,
          })),
        },
      );
    }),
  );
  return NAME;
}
