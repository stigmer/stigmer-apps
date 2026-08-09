/**
 * The typed resource clients — the ONLY data access the screens have
 * (T04b D2): generated service descriptors + Connect clients, no raw
 * fetch anywhere except the sanctioned document byte routes (D7,
 * api/files.ts). Handed to React through one context so tests swap the
 * whole surface with in-memory fakes.
 */

import { createClient, type Client, type Transport } from "@connectrpc/connect";
import { createContext, useContext, type ReactNode } from "react";
import type { FilesClient } from "./files.js";
import { CaseService } from "../gen/stigmer/law/case/v1/case_pb.js";
import { CaseNoteService } from "../gen/stigmer/law/casenote/v1/casenote_pb.js";
import { DocumentService } from "../gen/stigmer/law/document/v1/document_pb.js";
import { NotificationService } from "../gen/stigmer/law/notification/v1/notification_pb.js";
import { TaskService } from "../gen/stigmer/law/task/v1/task_pb.js";
import { TaskCommentService } from "../gen/stigmer/law/taskcomment/v1/taskcomment_pb.js";
import { UserService } from "../gen/stigmer/identity/user/v1/user_pb.js";

export interface ApiClients {
  readonly cases: Client<typeof CaseService>;
  readonly tasks: Client<typeof TaskService>;
  readonly notifications: Client<typeof NotificationService>;
  readonly caseNotes: Client<typeof CaseNoteService>;
  readonly taskComments: Client<typeof TaskCommentService>;
  readonly documents: Client<typeof DocumentService>;
  readonly users: Client<typeof UserService>;
  /** The byte routes (D7) — the one non-Connect member of the surface. */
  readonly files: FilesClient;
}

export function createApiClients(transport: Transport, files: FilesClient): ApiClients {
  return {
    cases: createClient(CaseService, transport),
    tasks: createClient(TaskService, transport),
    notifications: createClient(NotificationService, transport),
    caseNotes: createClient(CaseNoteService, transport),
    taskComments: createClient(TaskCommentService, transport),
    documents: createClient(DocumentService, transport),
    users: createClient(UserService, transport),
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
