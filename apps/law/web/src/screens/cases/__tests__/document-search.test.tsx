/**
 * The Documents-tab search (FR-DOC-004 on the web): a typed query swaps
 * the list for page-cited hits riding DocumentPageService.Search, gated
 * below the proto's two-character minimum, honest when nothing matches,
 * and opening a hit deep-links the reading frame at the cited page —
 * the T09.2 ?doc/?page citation seam's first consumer.
 */

import { create } from "@bufbuild/protobuf";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CaseSchema, ClientRole } from "../../../gen/stigmer/law/case/v1/case_pb.js";
import { ListCaseMembersResponseSchema } from "../../../gen/stigmer/law/casemember/v1/casemember_pb.js";
import { ClientSchema } from "../../../gen/stigmer/law/client/v1/client_pb.js";
import {
  DocumentCategory,
  DocumentSchema,
  ListDocumentsResponseSchema,
} from "../../../gen/stigmer/law/document/v1/document_pb.js";
import {
  DocumentPageSchema,
  SearchDocumentPagesResponseSchema,
} from "../../../gen/stigmer/law/documentpage/v1/documentpage_pb.js";
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
});

const CLIENT = create(ClientSchema, {
  metadata: { id: "client_1" },
  spec: { displayName: "Beta Industries" },
});

const STATEMENT = create(DocumentSchema, {
  metadata: { id: "doc_ws" },
  spec: {
    caseId: "case_1",
    fileName: "written-statement.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1234n,
    category: DocumentCategory.PLEADING,
  },
});

const HIT_PAGE = create(DocumentPageSchema, {
  metadata: { id: "dpg_1" },
  spec: {
    documentId: "doc_ws",
    caseId: "case_1",
    page: 4,
    text: "The suit is barred by limitation under Article 113 of the Limitation Act.",
  },
});

function fakeClients(searchItems: (typeof HIT_PAGE)[]) {
  return {
    cases: { get: vi.fn(async () => MATTER) },
    clients: { get: vi.fn(async () => CLIENT) },
    caseMembers: {
      list: vi.fn(async () => create(ListCaseMembersResponseSchema, { items: [] })),
    },
    documents: {
      get: vi.fn(async () => STATEMENT),
      list: vi.fn(async () =>
        create(ListDocumentsResponseSchema, { items: [STATEMENT], totalCount: 1n }),
      ),
    },
    documentPages: {
      search: vi.fn(async () =>
        create(SearchDocumentPagesResponseSchema, { items: searchItems }),
      ),
    },
    files: { uploadDocument: vi.fn(), downloadDocument: vi.fn() },
    firmMembers: fakeFirmMembers(),
  };
}

function renderDocumentsTab(clients: ReturnType<typeof fakeClients>) {
  return renderScreen(
    clients as never,
    [{ path: "/cases/:id", element: <CaseDetailScreen /> }],
    "/cases/case_1?tab=Documents",
  );
}

describe("Documents tab search", () => {
  it("gates below two characters — a hint, no request", async () => {
    const clients = fakeClients([HIT_PAGE]);
    renderDocumentsTab(clients);

    await userEvent.type(
      await screen.findByLabelText(/Search inside this matter/),
      "l",
    );
    expect(await screen.findByText("Type at least two letters to search.")).toBeInTheDocument();
    expect(clients.documentPages.search).not.toHaveBeenCalled();
    // The plain list is swapped out while a query is present.
    expect(screen.queryByRole("button", { name: "View" })).not.toBeInTheDocument();
  });

  it("renders page-cited hits with the match highlighted", async () => {
    const clients = fakeClients([HIT_PAGE]);
    renderDocumentsTab(clients);

    await userEvent.type(
      await screen.findByLabelText(/Search inside this matter/),
      "limitation",
    );

    const results = await screen.findByRole("list", { name: "Matching pages" });
    expect(results).toHaveTextContent("written-statement.pdf");
    expect(results).toHaveTextContent("page 4");
    // The match renders highlighted, in the page's own text.
    const marks = await screen.findAllByText("limitation", { selector: "mark" });
    expect(marks.length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(clients.documentPages.search).toHaveBeenCalledWith({
        query: "limitation",
        caseId: "case_1",
      }),
    );
  });

  it("opening a hit deep-links the reading frame at the cited page", async () => {
    const clients = fakeClients([HIT_PAGE]);
    const router = renderDocumentsTab(clients);

    await userEvent.type(
      await screen.findByLabelText(/Search inside this matter/),
      "limitation",
    );
    // Matched on the file name alone: accessible-name computation joins
    // the inline "— page N" span without the inter-element space, so a
    // regex spanning that join would encode a serializer quirk (the
    // citation's rendering is already pinned by the hits test above).
    await userEvent.click(
      await screen.findByRole("button", { name: /written-statement\.pdf/ }),
    );

    expect(router.state.location.search).toBe("?tab=Documents&doc=doc_ws&page=4");
  });

  it("says exactly why nothing matched — exact matching, scans searchable only once read", async () => {
    const clients = fakeClients([]);
    renderDocumentsTab(clients);

    await userEvent.type(
      await screen.findByLabelText(/Search inside this matter/),
      "nonexistent",
    );

    expect(await screen.findByText("No pages match")).toBeInTheDocument();
    expect(
      screen.getByText(/Matching is exact.*scans are searchable only after the system has read them/is),
    ).toBeInTheDocument();
  });
});
