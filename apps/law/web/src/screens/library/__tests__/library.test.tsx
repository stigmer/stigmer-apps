/**
 * The Library (FR-CIT-002 + FR-DOC-005): two honest piles (the
 * library's citations, judgments filed on matters), the upload front
 * door, the on-demand reliance trail, and Read semantics per pile —
 * library rows open the in-place viewer (?doc=), matter rows
 * deep-link their own case's viewer.
 */

import { create } from "@bufbuild/protobuf";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  CaseSummarySchema,
  ListCasesResponseSchema,
} from "../../../gen/stigmer/law/case/v1/case_pb.js";
import {
  CitationUseSchema,
  ListCitationUsesResponseSchema,
} from "../../../gen/stigmer/law/citationuse/v1/citationuse_pb.js";
import {
  DocumentCategory,
  DocumentSchema,
  ListDocumentsResponseSchema,
  type ListDocumentsRequest,
} from "../../../gen/stigmer/law/document/v1/document_pb.js";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { renderScreen } from "../../../test-support/render.js";
import { LibraryScreen } from "../LibraryScreen.js";

const SUMMARY = create(CaseSummarySchema, {
  id: "case_1",
  fileNumber: "CS/2026/042",
  caption: "Meridian Textiles vs Sunrise Traders",
});

const LIBRARY_JUDGMENT = create(DocumentSchema, {
  metadata: { id: "doc_lib" },
  spec: { fileName: "kesar-guidelines.pdf", category: DocumentCategory.JUDGMENT },
});
const MATTER_JUDGMENT = create(DocumentSchema, {
  metadata: { id: "doc_case" },
  spec: {
    caseId: "case_1",
    fileName: "silverline-award.pdf",
    category: DocumentCategory.JUDGMENT,
  },
});

function fakeClients() {
  return {
    documents: {
      list: vi.fn(async (req: MessageInitShape<typeof ListDocumentsResponseSchema>) => {
        const request = req as unknown as ListDocumentsRequest;
        const items = request.libraryOnly ? [LIBRARY_JUDGMENT] : [MATTER_JUDGMENT];
        return create(ListDocumentsResponseSchema, {
          items,
          totalCount: BigInt(items.length),
        });
      }),
    },
    citationUses: {
      list: vi.fn(async () =>
        create(ListCitationUsesResponseSchema, {
          items: [
            create(CitationUseSchema, {
              metadata: { id: "cuse_1" },
              spec: {
                documentId: "doc_lib",
                caseId: "case_1",
                proposition: "bail where the offence carries under seven years",
              },
              status: {
                caseFileNumber: "CS/2026/042",
                documentFileName: "kesar-guidelines.pdf",
              },
            }),
          ],
          totalCount: 1n,
        }),
      ),
      create: vi.fn(async (use: unknown) => use),
    },
    cases: {
      list: vi.fn(async () =>
        create(ListCasesResponseSchema, { items: [SUMMARY], totalCount: 1n }),
      ),
    },
    files: {
      uploadLibraryDocument: vi.fn(async () => LIBRARY_JUDGMENT),
    },
  };
}

describe("LibraryScreen (the firm's citation shelf)", () => {
  it("renders the two piles with the right Read semantics per pile", async () => {
    const clients = fakeClients();
    renderScreen(
      clients as never,
      [{ path: "/library", element: <LibraryScreen /> }],
      "/library",
    );

    // findByText per region: each pile's query resolves independently,
    // and the section titles render before their data.
    const shelf = await screen.findByRole("region", { name: "Citations in the library" });
    await within(shelf).findByText("kesar-guidelines.pdf");
    expect(within(shelf).getByText("Firm library")).toBeInTheDocument();
    // Library rows open in place (?doc=) — a button, not a case link.
    expect(within(shelf).getByRole("button", { name: "Read" })).toBeInTheDocument();

    const onMatters = screen.getByRole("region", { name: "Judgments filed on matters" });
    await within(onMatters).findByText("silverline-award.pdf");
    await within(onMatters).findByText(/filed on CS\/2026\/042/);
    // Matter rows deep-link their own case's viewer.
    expect(within(onMatters).getByRole("link", { name: "Read" })).toHaveAttribute(
      "href",
      "/cases/case_1?tab=Documents&doc=doc_case",
    );

    // The trail loads only on demand.
    expect(clients.citationUses.list).not.toHaveBeenCalled();
    await userEvent.click(within(shelf).getByRole("button", { name: "Where we used it" }));
    expect(await within(shelf).findByText(/under seven years/)).toBeInTheDocument();
  });

  it("uploads a judgment through the front door", async () => {
    const clients = fakeClients();
    renderScreen(
      clients as never,
      [{ path: "/library", element: <LibraryScreen /> }],
      "/library",
    );

    await screen.findByRole("region", { name: "Add to the library" });
    const file = new File(["%PDF-1.4 fictional judgment"], "bail-guidelines.pdf", {
      type: "application/pdf",
    });
    await userEvent.upload(
      screen.getByLabelText(/Upload a judgment/, { selector: "input" }),
      file,
    );

    await waitFor(() =>
      expect(clients.files.uploadLibraryDocument).toHaveBeenCalledWith(file),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(/added to the library/);
  });
});
