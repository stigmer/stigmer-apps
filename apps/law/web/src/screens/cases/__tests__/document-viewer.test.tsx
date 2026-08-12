/**
 * The in-app reading frame (T09.2): ?doc=<id> is derived from the URL
 * like the tab contract, swaps the whole detail frame, renders by mime
 * (iframe for PDF, img for images) on a blob object URL whose lifetime
 * IS the viewer's — jsdom has no createObjectURL, so the suite stubs
 * the pair and asserts create/revoke actually pair, turning the blob
 * lifecycle from a comment into a tested invariant.
 */

import { create } from "@bufbuild/protobuf";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CaseSchema, ClientRole } from "../../../gen/stigmer/law/case/v1/case_pb.js";
import { ListCaseMembersResponseSchema } from "../../../gen/stigmer/law/casemember/v1/casemember_pb.js";
import { ClientSchema } from "../../../gen/stigmer/law/client/v1/client_pb.js";
import {
  DocumentCategory,
  DocumentSchema,
  ListDocumentsResponseSchema,
} from "../../../gen/stigmer/law/document/v1/document_pb.js";
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

const PDF_DOC = create(DocumentSchema, {
  metadata: { id: "doc_pdf" },
  spec: {
    caseId: "case_1",
    fileName: "vakalatnama.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1234n,
    category: DocumentCategory.VAKALATNAMA,
  },
});

const PNG_DOC = create(DocumentSchema, {
  metadata: { id: "doc_png" },
  spec: {
    caseId: "case_1",
    fileName: "order-sheet.png",
    mimeType: "image/png",
    sizeBytes: 99n,
    category: DocumentCategory.ORDER_JUDGMENT,
  },
});

function fakeClients() {
  return {
    cases: { get: vi.fn(async () => MATTER) },
    clients: { get: vi.fn(async () => CLIENT) },
    caseMembers: {
      list: vi.fn(async () => create(ListCaseMembersResponseSchema, { items: [] })),
    },
    documents: {
      get: vi.fn(async (req: { id: string }) => {
        const found = [PDF_DOC, PNG_DOC].find((d) => d.metadata?.id === req.id);
        if (!found) throw new Error(`document '${req.id}' is not on a matter visible to you`);
        return found;
      }),
      list: vi.fn(async () =>
        create(ListDocumentsResponseSchema, { items: [PDF_DOC, PNG_DOC], totalCount: 2n }),
      ),
    },
    files: {
      uploadDocument: vi.fn(),
      downloadDocument: vi.fn(async () => new Blob(["bytes"], { type: "application/pdf" })),
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

/* jsdom ships no object-URL surface at all — stub the pair. */
let urlCounter = 0;
const createObjectURL = vi.fn(() => `blob:test-${++urlCounter}`);
const revokeObjectURL = vi.fn();
URL.createObjectURL = createObjectURL;
URL.revokeObjectURL = revokeObjectURL;

beforeEach(() => {
  urlCounter = 0;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
});

afterAll(() => {
  // @ts-expect-error — restoring jsdom's original (absent) surface.
  delete URL.createObjectURL;
  // @ts-expect-error — restoring jsdom's original (absent) surface.
  delete URL.revokeObjectURL;
});

describe("DocumentViewer (URL-derived reading frame)", () => {
  it("a ?doc= deep link swaps the frame for the PDF iframe on a blob URL", async () => {
    renderDetail(fakeClients(), "/cases/case_1?tab=Documents&doc=doc_pdf");

    const frame = await screen.findByTitle("vakalatnama.pdf");
    expect(frame).toHaveAttribute("src", "blob:test-1");
    expect(screen.getByText("Vakalatnama")).toBeInTheDocument();
    // The whole frame swapped: no rail, no tab strip.
    expect(screen.queryByRole("complementary", { name: "Matter facts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Matter sections" })).not.toBeInTheDocument();
  });

  it("?page= rides as the PDF open-parameter fragment (the citation seam)", async () => {
    renderDetail(fakeClients(), "/cases/case_1?doc=doc_pdf&page=4");

    const frame = await screen.findByTitle("vakalatnama.pdf");
    expect(frame).toHaveAttribute("src", "blob:test-1#page=4");
  });

  it("an image document renders as an img, not an iframe", async () => {
    renderDetail(fakeClients(), "/cases/case_1?doc=doc_png");

    const image = await screen.findByRole("img", { name: "order-sheet.png" });
    expect(image).toHaveAttribute("src", "blob:test-1");
    expect(screen.queryByTitle("order-sheet.png")).not.toBeInTheDocument();
  });

  it("Close lands on the Documents tab and revokes the blob URL", async () => {
    const clients = fakeClients();
    const router = renderDetail(clients, "/cases/case_1?tab=Documents&doc=doc_pdf");

    await screen.findByTitle("vakalatnama.pdf");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(await screen.findByRole("region", { name: "Documents" })).toBeInTheDocument();
    expect(router.state.location.search).toBe("?tab=Documents");
    // The lifecycle invariant: what was created is revoked, on close.
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:test-1"));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("View on a list row pushes ?doc= and opens the reading frame", async () => {
    const router = renderDetail(fakeClients(), "/cases/case_1?tab=Documents");

    const list = await screen.findByRole("region", { name: "Documents" });
    expect(list).toBeInTheDocument();
    const viewButtons = await screen.findAllByRole("button", { name: "View" });
    await userEvent.click(viewButtons[0]!);

    expect(await screen.findByTitle("vakalatnama.pdf")).toBeInTheDocument();
    expect(router.state.location.search).toBe("?tab=Documents&doc=doc_pdf");
  });

  it("a foreign document id fails closed with the server's sentence", async () => {
    renderDetail(fakeClients(), "/cases/case_1?doc=doc_foreign");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("doc_foreign");
    expect(screen.queryByTitle("vakalatnama.pdf")).not.toBeInTheDocument();
  });
});
