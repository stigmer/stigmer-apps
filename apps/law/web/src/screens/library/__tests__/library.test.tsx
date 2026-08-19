/**
 * The Library (FR-CIT-002): the judgment collection with each row's
 * reliance trail loaded on demand, a use recorded against the caller's
 * own matters, and Read landing in the owning matter's viewer.
 */

import { create } from "@bufbuild/protobuf";
import { screen, waitFor } from "@testing-library/react";
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
} from "../../../gen/stigmer/law/document/v1/document_pb.js";
import { renderScreen } from "../../../test-support/render.js";
import { LibraryScreen } from "../LibraryScreen.js";

const SUMMARY = create(CaseSummarySchema, {
  id: "case_1",
  fileNumber: "CS/2026/042",
  caption: "Meridian Textiles vs Sunrise Traders",
});

function fakeClients(uses = [
  create(CitationUseSchema, {
    metadata: { id: "cuse_1" },
    spec: {
      documentId: "doc_1",
      caseId: "case_1",
      proposition: "bail where the offence carries under seven years",
    },
    status: { caseFileNumber: "CS/2026/042", documentFileName: "kesar-bail-order.pdf" },
  }),
]) {
  return {
    documents: {
      list: vi.fn(async () =>
        create(ListDocumentsResponseSchema, {
          items: [
            create(DocumentSchema, {
              metadata: { id: "doc_1" },
              spec: {
                caseId: "case_1",
                fileName: "kesar-bail-order.pdf",
                category: DocumentCategory.JUDGMENT,
              },
            }),
          ],
          totalCount: 1n,
        }),
      ),
    },
    citationUses: {
      list: vi.fn(async () =>
        create(ListCitationUsesResponseSchema, {
          items: uses,
          totalCount: BigInt(uses.length),
        }),
      ),
      create: vi.fn(async (use: unknown) => use),
    },
    cases: {
      list: vi.fn(async () =>
        create(ListCasesResponseSchema, { items: [SUMMARY], totalCount: 1n }),
      ),
    },
  };
}

describe("LibraryScreen (the judgment collection, FR-CIT-002)", () => {
  it("lists the collection with the owning matter, and opens a row's reliance trail on demand", async () => {
    const clients = fakeClients();
    renderScreen(
      clients as never,
      [{ path: "/library", element: <LibraryScreen /> }],
      "/library",
    );

    expect(await screen.findByText("kesar-bail-order.pdf")).toBeInTheDocument();
    expect(screen.getByText(/filed on CS\/2026\/042/)).toBeInTheDocument();
    // The trail loads only when the row opens.
    expect(clients.citationUses.list).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Where we used it" }));
    expect(await screen.findByText(/under seven years/)).toBeInTheDocument();

    // Read lands in the owning matter's viewer (?doc= deep link).
    expect(screen.getByRole("link", { name: "Read" })).toHaveAttribute(
      "href",
      "/cases/case_1?tab=Documents&doc=doc_1",
    );
  });

  it("records a use against one of the caller's matters", async () => {
    const clients = fakeClients([]);
    renderScreen(
      clients as never,
      [{ path: "/library", element: <LibraryScreen /> }],
      "/library",
    );

    await userEvent.click(await screen.findByRole("button", { name: "Where we used it" }));
    expect(await screen.findByText(/No recorded uses yet/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Record a use" }));
    await userEvent.selectOptions(screen.getByLabelText("Used in"), "CS/2026/042");
    await userEvent.type(
      screen.getByLabelText("For what proposition"),
      "anticipatory bail guidelines",
    );
    await userEvent.click(screen.getByRole("button", { name: "Record use" }));

    await waitFor(() =>
      expect(clients.citationUses.create).toHaveBeenCalledWith(
        expect.objectContaining({
          spec: expect.objectContaining({
            documentId: "doc_1",
            caseId: "case_1",
            proposition: "anticipatory bail guidelines",
          }),
        }),
      ),
    );
  });
});
