/**
 * The typed resource clients — the ONLY data access the screens have
 * (T04b D2): generated service descriptors + Connect clients, no raw
 * fetch anywhere except the sanctioned document byte routes (D7,
 * api/files.ts). Handed to React through one context so tests swap the
 * whole surface with in-memory fakes.
 *
 * UserService is present for ACCOUNT ADMINISTRATION only (DD-003 D4:
 * the managing partner creates accounts, keeps profiles current, and
 * issues activation codes — the server refuses everyone else). Person
 * NAMES still resolve through the FirmMember roster everywhere; User
 * list stays denied to firm staff.
 */

import { createClient, type Client, type Transport } from "@connectrpc/connect";
import { createContext, useContext, type ReactNode } from "react";
import type { FilesClient } from "./files.js";
import { AssistantService } from "../gen/stigmer/law/assistant/v1/assistant_pb.js";
import { AuditEntryService } from "../gen/stigmer/law/auditentry/v1/auditentry_pb.js";
import { CaseService } from "../gen/stigmer/law/case/v1/case_pb.js";
import { CaseActService } from "../gen/stigmer/law/caseact/v1/caseact_pb.js";
import { CaseMemberService } from "../gen/stigmer/law/casemember/v1/casemember_pb.js";
import { CaseNoteService } from "../gen/stigmer/law/casenote/v1/casenote_pb.js";
import { CitationUseService } from "../gen/stigmer/law/citationuse/v1/citationuse_pb.js";
import { ClientService } from "../gen/stigmer/law/client/v1/client_pb.js";
import { DeadlineService } from "../gen/stigmer/law/deadline/v1/deadline_pb.js";
import { DocumentService } from "../gen/stigmer/law/document/v1/document_pb.js";
import { DocumentAnnotationService } from "../gen/stigmer/law/documentannotation/v1/documentannotation_pb.js";
import { DocumentPageService } from "../gen/stigmer/law/documentpage/v1/documentpage_pb.js";
import { FeeArrangementService } from "../gen/stigmer/law/feearrangement/v1/feearrangement_pb.js";
import { FirmMemberService } from "../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import { HearingService } from "../gen/stigmer/law/hearing/v1/hearing_pb.js";
import { LedgerEntryService } from "../gen/stigmer/law/ledgerentry/v1/ledgerentry_pb.js";
import { NotificationService } from "../gen/stigmer/law/notification/v1/notification_pb.js";
import { TaskService } from "../gen/stigmer/law/task/v1/task_pb.js";
import { TaskCommentService } from "../gen/stigmer/law/taskcomment/v1/taskcomment_pb.js";
import { UserService } from "../gen/stigmer/identity/user/v1/user_pb.js";

export interface ApiClients {
  readonly cases: Client<typeof CaseService>;
  /** The matter's statutory frame (FR-ACT-001) — manual entry. */
  readonly caseActs: Client<typeof CaseActService>;
  /** The reliance trail on the judgment library (FR-CIT-001) — append-only. */
  readonly citationUses: Client<typeof CitationUseService>;
  readonly caseMembers: Client<typeof CaseMemberService>;
  readonly hearings: Client<typeof HearingService>;
  readonly deadlines: Client<typeof DeadlineService>;
  readonly clients: Client<typeof ClientService>;
  readonly firmMembers: Client<typeof FirmMemberService>;
  readonly feeArrangements: Client<typeof FeeArrangementService>;
  readonly ledgerEntries: Client<typeof LedgerEntryService>;
  readonly auditEntries: Client<typeof AuditEntryService>;
  readonly tasks: Client<typeof TaskService>;
  readonly notifications: Client<typeof NotificationService>;
  readonly caseNotes: Client<typeof CaseNoteService>;
  readonly taskComments: Client<typeof TaskCommentService>;
  readonly documents: Client<typeof DocumentService>;
  /** Marks with comments on filed documents (DD-010) — append-only. */
  readonly documentAnnotations: Client<typeof DocumentAnnotationService>;
  /** Extracted page text — the in-app document content search (FR-DOC-004). */
  readonly documentPages: Client<typeof DocumentPageService>;
  /** Account administration (DD-003 D4) — managing partner + operator only. */
  readonly users: Client<typeof UserService>;
  /** The assistant access surface (T05 web leg): config + token mint. */
  readonly assistant: Client<typeof AssistantService>;
  /** The byte routes (D7) — the one non-Connect member of the surface. */
  readonly files: FilesClient;
}

export function createApiClients(transport: Transport, files: FilesClient): ApiClients {
  return {
    cases: createClient(CaseService, transport),
    caseActs: createClient(CaseActService, transport),
    citationUses: createClient(CitationUseService, transport),
    caseMembers: createClient(CaseMemberService, transport),
    hearings: createClient(HearingService, transport),
    deadlines: createClient(DeadlineService, transport),
    clients: createClient(ClientService, transport),
    firmMembers: createClient(FirmMemberService, transport),
    feeArrangements: createClient(FeeArrangementService, transport),
    ledgerEntries: createClient(LedgerEntryService, transport),
    auditEntries: createClient(AuditEntryService, transport),
    tasks: createClient(TaskService, transport),
    notifications: createClient(NotificationService, transport),
    caseNotes: createClient(CaseNoteService, transport),
    taskComments: createClient(TaskCommentService, transport),
    documents: createClient(DocumentService, transport),
    documentAnnotations: createClient(DocumentAnnotationService, transport),
    documentPages: createClient(DocumentPageService, transport),
    users: createClient(UserService, transport),
    assistant: createClient(AssistantService, transport),
    files,
  };
}

const ClientsContext = createContext<ApiClients | undefined>(undefined);

export function ApiClientsProvider(props: { clients: ApiClients; children: ReactNode }) {
  return <ClientsContext.Provider value={props.clients}>{props.children}</ClientsContext.Provider>;
}

export function useApiClients(): ApiClients {
  const clients = useContext(ClientsContext);
  if (!clients) {
    throw new Error("useApiClients must be used within <ApiClientsProvider> — wrap the app in it (src/main.tsx)");
  }
  return clients;
}
