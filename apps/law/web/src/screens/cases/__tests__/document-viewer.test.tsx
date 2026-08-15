/**
 * The in-app reading frame (T09.2, re-rendered by T12): ?doc=<id> is
 * derived from the URL like the tab contract, swaps the whole detail
 * frame, and renders by mime — the pdfjs reader for PDFs (mocked at
 * its ONE seam, src/pdf/pdfjs.ts; jsdom paints no canvas — real
 * rendering is Playwright's assertion), an img on a blob object URL
 * for images. The object URL (still the Download path for both kinds)
 * keeps its tested create/revoke pairing.
 */

import { create } from "@bufbuild/protobuf";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CaseSchema, ClientRole } from "../../../gen/stigmer/law/case/v1/case_pb.js";
import { ListCaseMembersResponseSchema } from "../../../gen/stigmer/law/casemember/v1/casemember_pb.js";
import { ClientSchema } from "../../../gen/stigmer/law/client/v1/client_pb.js";
import {
  DocumentCategory,
  DocumentSchema,
  ListDocumentsResponseSchema,
} from "../../../gen/stigmer/law/document/v1/document_pb.js";
import { ListDocumentAnnotationsResponseSchema } from "../../../gen/stigmer/law/documentannotation/v1/documentannotation_pb.js";
import { computeLayout, scrollOffsetForPage } from "../../../pdf/geometry.js";
import { fakeFirmMembers, renderScreen } from "../../../test-support/render.js";
import { CaseDetailScreen } from "../CaseDetailScreen.js";

const PAGE_COUNT = 5;
const PAGE_SIZE = { width: 612, height: 792 };

vi.mock("../../../pdf/pdfjs.js", () => ({
  getDocument: (_args: { data: unknown }) => ({
    promise: Promise.resolve({
      numPages: PAGE_COUNT,
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: PAGE_SIZE.width * scale,
          height: PAGE_SIZE.height * scale,
          scale,
        }),
        render: () => ({ promise: Promise.resolve(), cancel() {} }),
        streamTextContent: () => ({}),
        getTextContent: async () => ({ items: [{ str: "" }] }),
      }),
    }),
    destroy: async () => {},
  }),
  OutputScale: class {
    sx = 1;
    sy = 1;
    scaled = false;
  },
  TextLayer: class {
    async render() {}
    cancel() {}
  },
  PDF_ASSET_OPTIONS: {},
}));

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

/** jsdom's Blob lacks arrayBuffer(); the byte route answers this
 * blob-shaped stand-in with exactly the surface the viewer consumes. */
function fakeBytes(type: string) {
  return { type, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Blob;
}

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
      downloadDocument: vi.fn(async (id: string) =>
        fakeBytes(id === "doc_pdf" ? "application/pdf" : "image/png"),
      ),
    },
    // The viewer always mounts the marks panel (T13); this suite keeps
    // it empty — mark behavior lives in annotations.test.tsx.
    documentAnnotations: {
      list: vi.fn(async () =>
        create(ListDocumentAnnotationsResponseSchema, { items: [], totalCount: 0n }),
      ),
      create: vi.fn(),
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

// The reader's fit-width hook observes its frame; jsdom has no
// ResizeObserver (per-suite stub, the matchMedia precedent).
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterAll(() => {
  vi.unstubAllGlobals();
  // @ts-expect-error — restoring jsdom's original (absent) surface.
  delete URL.createObjectURL;
  // @ts-expect-error — restoring jsdom's original (absent) surface.
  delete URL.revokeObjectURL;
});

beforeEach(() => {
  urlCounter = 0;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
});

describe("DocumentViewer (URL-derived reading frame)", () => {
  it("a ?doc= deep link swaps the frame for the pdf reader", async () => {
    renderDetail(fakeClients(), "/cases/case_1?tab=Documents&doc=doc_pdf");

    // The reader's reading surface, named by the file (the lazy chunk
    // and the fake document both resolve inside this wait).
    expect(await screen.findByRole("region", { name: "vakalatnama.pdf" })).toBeInTheDocument();
    expect(await screen.findByText(`/ ${PAGE_COUNT}`)).toBeInTheDocument();
    expect(screen.getByText("Vakalatnama")).toBeInTheDocument();
    // The whole frame swapped: no rail, no tab strip.
    expect(screen.queryByRole("complementary", { name: "Matter facts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Matter sections" })).not.toBeInTheDocument();
  });

  it("?page= scrolls the reader to the cited page (the citation seam)", async () => {
    renderDetail(fakeClients(), "/cases/case_1?doc=doc_pdf&page=4");

    const surface = await screen.findByRole("region", { name: "vakalatnama.pdf" });
    // jsdom reports zero frame width, so the reader falls back to
    // scale 1 — the expectation reuses the reader's own geometry.
    const layout = computeLayout(Array.from({ length: PAGE_COUNT }, () => PAGE_SIZE), 1);
    await waitFor(() => expect(surface.scrollTop).toBe(scrollOffsetForPage(layout, 4)));
  });

  it("an image document renders as an img, not the pdf reader", async () => {
    renderDetail(fakeClients(), "/cases/case_1?doc=doc_png");

    const image = await screen.findByRole("img", { name: "order-sheet.png" });
    expect(image).toHaveAttribute("src", "blob:test-1");
    expect(screen.queryByRole("region", { name: "order-sheet.png" })).not.toBeInTheDocument();
  });

  it("Close lands on the Documents tab and revokes the Download blob URL", async () => {
    const clients = fakeClients();
    const router = renderDetail(clients, "/cases/case_1?tab=Documents&doc=doc_pdf");

    await screen.findByRole("region", { name: "vakalatnama.pdf" });
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

    expect(await screen.findByRole("region", { name: "vakalatnama.pdf" })).toBeInTheDocument();
    expect(router.state.location.search).toBe("?tab=Documents&doc=doc_pdf");
  });

  it("a foreign document id fails closed with the server's sentence", async () => {
    renderDetail(fakeClients(), "/cases/case_1?doc=doc_foreign");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("doc_foreign");
    expect(screen.queryByRole("region", { name: "vakalatnama.pdf" })).not.toBeInTheDocument();
  });
});
