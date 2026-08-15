/**
 * Document annotations in the viewer (T13, DD-010): saved marks render
 * on the page through the kit's MarkerLayer and read in the panel
 * (author from the roster, quoted text or the region label, the
 * comment, jump-to-page through the reader controller); a region drag
 * on an image becomes a draft, and the panel's comment form turns the
 * draft into the create call. jsdom paints nothing — the real pixels
 * are Playwright's assertion; this suite covers the wiring.
 */

import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CaseSchema, ClientRole } from "../../../gen/stigmer/law/case/v1/case_pb.js";
import { ListCaseMembersResponseSchema } from "../../../gen/stigmer/law/casemember/v1/casemember_pb.js";
import { ClientSchema } from "../../../gen/stigmer/law/client/v1/client_pb.js";
import {
  DocumentCategory,
  DocumentSchema,
  ListDocumentsResponseSchema,
} from "../../../gen/stigmer/law/document/v1/document_pb.js";
import {
  AnnotationKind,
  DocumentAnnotationSchema,
  ListDocumentAnnotationsResponseSchema,
  type DocumentAnnotation,
} from "../../../gen/stigmer/law/documentannotation/v1/documentannotation_pb.js";
import { computeLayout, scrollOffsetForPage } from "../../../pdf/geometry.js";
import { fakeFirmMembers, renderScreen } from "../../../test-support/render.js";
import { CaseDetailScreen } from "../CaseDetailScreen.js";

const PAGE_COUNT = 3;
const PAGE_SIZE = { width: 612, height: 792 };

vi.mock("../../../pdf/pdfjs.js", () => ({
  getDocument: () => ({
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

const PDF_DOC = create(DocumentSchema, {
  metadata: { id: "doc_pdf" },
  spec: {
    caseId: "case_1",
    fileName: "written-statement.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1234n,
    category: DocumentCategory.PLEADING,
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

/** A senior's highlight on page 1 and a region on page 2 — authored by
 * the roster's colleague so the panel proves the name join. */
const MARKS: DocumentAnnotation[] = [
  create(DocumentAnnotationSchema, {
    metadata: {
      id: "ann_1",
      createdBy: { id: "usr_ravi" },
      createdAt: timestampFromDate(new Date("2026-08-15T10:00:00Z")),
    },
    spec: {
      documentId: "doc_pdf",
      caseId: "case_1",
      page: 1,
      annotationKind: AnnotationKind.HIGHLIGHT,
      rects: [
        { left: 0.1, top: 0.2, width: 0.5, height: 0.02 },
        { left: 0.1, top: 0.23, width: 0.3, height: 0.02 },
      ],
      quotedText: "barred by limitation",
      body: "Limitation defence — cite Art. 113",
    },
  }),
  create(DocumentAnnotationSchema, {
    metadata: {
      id: "ann_2",
      createdBy: { id: "usr_ravi" },
      createdAt: timestampFromDate(new Date("2026-08-15T11:00:00Z")),
    },
    spec: {
      documentId: "doc_pdf",
      caseId: "case_1",
      page: 2,
      annotationKind: AnnotationKind.REGION,
      rects: [{ left: 0.4, top: 0.4, width: 0.2, height: 0.1 }],
      quotedText: "",
      body: "Stamp illegible — check with the registry",
    },
  }),
];

function fakeBytes(type: string) {
  return { type, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Blob;
}

function fakeClients(marks: DocumentAnnotation[]) {
  return {
    cases: { get: vi.fn(async () => MATTER) },
    clients: {
      get: vi.fn(async () =>
        create(ClientSchema, { metadata: { id: "client_1" }, spec: { displayName: "Beta" } }),
      ),
    },
    caseMembers: {
      list: vi.fn(async () => create(ListCaseMembersResponseSchema, { items: [] })),
    },
    documents: {
      get: vi.fn(async (req: { id: string }) => {
        const found = [PDF_DOC, PNG_DOC].find((d) => d.metadata?.id === req.id);
        if (!found) throw new Error("not visible");
        return found;
      }),
      list: vi.fn(async () =>
        create(ListDocumentsResponseSchema, { items: [PDF_DOC, PNG_DOC], totalCount: 2n }),
      ),
    },
    documentAnnotations: {
      list: vi.fn(async () =>
        create(ListDocumentAnnotationsResponseSchema, {
          items: marks,
          totalCount: BigInt(marks.length),
        }),
      ),
      create: vi.fn(async (annotation: DocumentAnnotation) => annotation),
    },
    files: {
      uploadDocument: vi.fn(),
      downloadDocument: vi.fn(async (id: string) =>
        fakeBytes(id === "doc_pdf" ? "application/pdf" : "image/png"),
      ),
    },
    firmMembers: fakeFirmMembers(),
  };
}

URL.createObjectURL ??= () => "blob:test";
URL.revokeObjectURL ??= () => {};

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Element.prototype.setPointerCapture ??= () => {};
});
afterAll(() => vi.unstubAllGlobals());

function renderViewer(clients: ReturnType<typeof fakeClients>, doc: string) {
  return renderScreen(
    clients as never,
    [{ path: "/cases/:id", element: <CaseDetailScreen /> }],
    `/cases/case_1?tab=Documents&doc=${doc}`,
  );
}

describe("document annotations (viewer + panel)", () => {
  it("saved marks render on their pages through the marker layer", async () => {
    renderViewer(fakeClients(MARKS), "doc_pdf");
    const page1 = await screen.findByRole("group", { name: "Page 1 of 3" });
    const page2 = await screen.findByRole("group", { name: "Page 2 of 3" });

    // The highlight's TWO per-line rects on page 1; the region on 2.
    await waitFor(() => expect(page1.querySelectorAll(".law-mark-highlight")).toHaveLength(2));
    expect(page1.querySelectorAll(".law-mark-region")).toHaveLength(0);
    expect(page2.querySelectorAll(".law-mark-region")).toHaveLength(1);
    // Percentage positioning — the normalized anchor IS the style.
    const first = page1.querySelector(".law-mark-highlight") as HTMLElement;
    expect(first.style.left).toBe("10%");
    expect(first.style.top).toBe("20%");
  });

  it("the panel reads the trail: author, quoted text or region label, comment — and jumps to the page", async () => {
    renderViewer(fakeClients(MARKS), "doc_pdf");
    const panel = await screen.findByRole("region", { name: "Marks" });
    const surface = await screen.findByRole("region", { name: "written-statement.pdf" });

    // Author names join through the roster (usr_ravi → Ravi Iyer).
    expect((await screen.findAllByText("Ravi Iyer")).length).toBe(2);
    expect(panel).toHaveTextContent("barred by limitation");
    expect(panel).toHaveTextContent("Limitation defence — cite Art. 113");
    expect(panel).toHaveTextContent("Marked region");
    expect(panel).toHaveTextContent("Stamp illegible — check with the registry");

    await userEvent.click(screen.getByRole("button", { name: "Page 2 →" }));
    const layout = computeLayout(Array.from({ length: PAGE_COUNT }, () => PAGE_SIZE), 1);
    await waitFor(() => expect(surface.scrollTop).toBe(scrollOffsetForPage(layout, 2)));
  });

  it("an empty document answers honestly", async () => {
    renderViewer(fakeClients([]), "doc_pdf");
    expect(await screen.findByText("No marks yet")).toBeInTheDocument();
  });

  it("a region drag on an image becomes a draft; the comment form creates the mark (page 1, region, verified case)", async () => {
    const clients = fakeClients([]);
    renderViewer(clients, "doc_png");
    await screen.findByRole("img", { name: "order-sheet.png" });

    // Arm the tool and drag on the image's draw layer (box stubbed —
    // jsdom computes no layout).
    await userEvent.click(screen.getByRole("button", { name: "Mark region" }));
    const layer = document.querySelector("[data-region-draw-layer]") as HTMLElement;
    layer.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.pointerDown(layer, { pointerId: 1, button: 0, clientX: 200, clientY: 150 });
    fireEvent.pointerUp(layer, { pointerId: 1, clientX: 400, clientY: 300 });

    // The draft form appears; the comment is required.
    expect(await screen.findByText("New mark — page 1 (marked region)")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Comment"), "Registry stamp missing");
    await userEvent.click(screen.getByRole("button", { name: "Save mark" }));

    await waitFor(() => expect(clients.documentAnnotations.create).toHaveBeenCalledTimes(1));
    const sent = clients.documentAnnotations.create.mock.calls[0]?.[0] as DocumentAnnotation;
    expect(sent.spec?.documentId).toBe("doc_png");
    expect(sent.spec?.caseId).toBe("case_1");
    expect(sent.spec?.page).toBe(1);
    expect(sent.spec?.annotationKind).toBe(AnnotationKind.REGION);
    expect(sent.spec?.rects).toHaveLength(1);
    expect(sent.spec?.rects[0]?.left).toBeCloseTo(0.25, 5);
    expect(sent.spec?.body).toBe("Registry stamp missing");
    // The form closes; the list refetches (create invalidates the key).
    await waitFor(() =>
      expect(screen.queryByText("New mark — page 1 (marked region)")).not.toBeInTheDocument(),
    );
    expect(clients.documentAnnotations.list.mock.calls.length).toBeGreaterThan(1);
  });
});
