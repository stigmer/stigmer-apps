/**
 * The case tab contract (DD-005): the active tab is DERIVED from the
 * URL on every render, validated against the caller's currently-allowed
 * set — a partner can deep-link ?tab=History; the same link renders the
 * Diary for an associate (the tab does not exist for them, and the
 * server would refuse its data regardless); picking a tab writes the
 * URL so the view is shareable.
 */

import { create } from "@bufbuild/protobuf";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ListAuditEntriesResponseSchema } from "../../../gen/stigmer/law/auditentry/v1/auditentry_pb.js";
import { CaseSchema, ClientRole } from "../../../gen/stigmer/law/case/v1/case_pb.js";
import { ListCaseMembersResponseSchema } from "../../../gen/stigmer/law/casemember/v1/casemember_pb.js";
import { ListCaseNotesResponseSchema } from "../../../gen/stigmer/law/casenote/v1/casenote_pb.js";
import { ClientSchema } from "../../../gen/stigmer/law/client/v1/client_pb.js";
import {
  FirmMemberSchema,
  FirmRole,
} from "../../../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import { ListHearingsResponseSchema } from "../../../gen/stigmer/law/hearing/v1/hearing_pb.js";
import { fakeFirmMembers, renderScreen } from "../../../test-support/render.js";
import { CaseDetailScreen } from "../CaseDetailScreen.js";

const MATTER = create(CaseSchema, {
  metadata: { id: "case_1" },
  spec: {
    fileNumber: "CS/2026/042",
    clientId: "client_1",
    clientRole: ClientRole.PETITIONER,
    leadLawyerId: "fmem_me",
    forum: { name: "High Court" },
  },
  status: { nextHearingDate: "2026-09-12" },
});

const CLIENT = create(ClientSchema, {
  metadata: { id: "client_1" },
  spec: { displayName: "Beta Industries" },
});

/** The caller's own profile as a NON-partner (the harness default is a
 * managing partner). */
const ASSOCIATE_ME = create(FirmMemberSchema, {
  metadata: { id: "fmem_me" },
  spec: { userId: "usr_me", role: FirmRole.ASSOCIATE, active: true },
  status: { userName: "Asha Rao", userEmail: "asha@acme.example" },
});

function fakeClients() {
  return {
    cases: { get: vi.fn(async () => MATTER) },
    clients: { get: vi.fn(async () => CLIENT) },
    caseMembers: {
      list: vi.fn(async () => create(ListCaseMembersResponseSchema, { items: [] })),
    },
    hearings: {
      list: vi.fn(async () => create(ListHearingsResponseSchema, { items: [] })),
    },
    caseNotes: {
      list: vi.fn(async () => create(ListCaseNotesResponseSchema, { items: [] })),
    },
    auditEntries: {
      list: vi.fn(async () => create(ListAuditEntriesResponseSchema, { items: [] })),
    },
    firmMembers: fakeFirmMembers(),
  };
}

function renderDetail(clients: ReturnType<typeof fakeClients>, initialPath: string) {
  return renderScreen(
    clients as never,
    [{ path: "/cases/:id", element: <CaseDetailScreen /> }],
    initialPath,
  );
}

describe("CaseDetailScreen tabs (URL-derived, role-validated)", () => {
  it("a partner deep link to ?tab=History renders the History tab", async () => {
    renderDetail(fakeClients(), "/cases/case_1?tab=History");

    expect(await screen.findByRole("region", { name: "History" })).toBeInTheDocument();
    expect(await screen.findByText("No changes recorded yet")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Diary" })).not.toBeInTheDocument();
  });

  it("the same link renders the Diary for an associate — the tab does not exist for them", async () => {
    const clients = fakeClients();
    clients.firmMembers.get = vi.fn(async () => ASSOCIATE_ME);
    renderDetail(clients, "/cases/case_1?tab=History");

    expect(await screen.findByRole("region", { name: "Diary" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "History" })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("region", { name: "History" })).not.toBeInTheDocument();
  });

  it("picking a tab writes the URL; the Diary default keeps it clean", async () => {
    const router = renderDetail(fakeClients(), "/cases/case_1");

    expect(await screen.findByRole("region", { name: "Diary" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Notes" }));
    expect(await screen.findByRole("region", { name: "Notes" })).toBeInTheDocument();
    expect(router.state.location.search).toBe("?tab=Notes");

    await userEvent.click(screen.getByRole("button", { name: "Diary" }));
    expect(await screen.findByRole("region", { name: "Diary" })).toBeInTheDocument();
    expect(router.state.location.search).toBe("");
  });

  it("the rail's team glance jumps to the Team tab for management", async () => {
    const router = renderDetail(fakeClients(), "/cases/case_1");

    await screen.findByRole("complementary", { name: "Matter facts" });
    await userEvent.click(screen.getByRole("button", { name: "Manage" }));

    expect(await screen.findByRole("region", { name: "Working team" })).toBeInTheDocument();
    expect(router.state.location.search).toBe("?tab=Team");
  });
});
