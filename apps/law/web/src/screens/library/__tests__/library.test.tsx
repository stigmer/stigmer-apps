/**
 * The Library (FR-CIT-002 + DD-012 D2): the citation SHELF — identity
 * rendered over file names, provenance badges (filed vs promoted), the
 * on-demand reliance trail, in-place identity correction, the identity
 * + page-text search pair, and the front door that files bytes and
 * identity in one act.
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
  CitationSchema,
  ListCitationsResponseSchema,
  SearchCitationsResponseSchema,
} from "../../../gen/stigmer/law/citation/v1/citation_pb.js";
import {
  CitationUseSchema,
  ListCitationUsesResponseSchema,
} from "../../../gen/stigmer/law/citationuse/v1/citationuse_pb.js";
import { SearchDocumentPagesResponseSchema } from "../../../gen/stigmer/law/documentpage/v1/documentpage_pb.js";
import { renderScreen } from "../../../test-support/render.js";
import { LibraryScreen } from "../LibraryScreen.js";

const SUMMARY = create(CaseSummarySchema, {
  id: "case_1",
  fileNumber: "CS/2026/042",
  caption: "Meridian Textiles vs Sunrise Traders",
});

const FILED_ENTRY = create(CitationSchema, {
  metadata: { id: "cit_1" },
  spec: {
    documentId: "doc_lib",
    title: "Kesar vs State",
    court: "Supreme Court",
    year: 2014,
    citation: "AIR 2014 SC 1",
  },
  status: { documentFileName: "kesar-guidelines.pdf" },
});
const PROMOTED_ENTRY = create(CitationSchema, {
  metadata: { id: "cit_2" },
  spec: {
    documentId: "doc_promoted",
    title: "Meridian vs Silverline",
    promotedFromCaseId: "case_1",
    promotedFromDocumentId: "doc_case",
  },
  status: {
    documentFileName: "silverline-award.pdf",
    promotedFromFileNumber: "CS/2026/042",
  },
});

function fakeClients() {
  return {
    citations: {
      list: vi.fn(async () =>
        create(ListCitationsResponseSchema, {
          items: [FILED_ENTRY, PROMOTED_ENTRY],
          totalCount: 2n,
        }),
      ),
      search: vi.fn(async () =>
        create(SearchCitationsResponseSchema, { items: [FILED_ENTRY] }),
      ),
      update: vi.fn(async (entry: unknown) => entry),
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
    documentPages: {
      search: vi.fn(async () => create(SearchDocumentPagesResponseSchema, { items: [] })),
    },
    cases: {
      list: vi.fn(async () =>
        create(ListCasesResponseSchema, { items: [SUMMARY], totalCount: 1n }),
      ),
    },
    files: {
      uploadLibraryDocument: vi.fn(async () => ({ metadata: { id: "doc_new" } })),
    },
  };
}

describe("LibraryScreen (the citation shelf, DD-012 D2)", () => {
  it("renders the shelf with identity, provenance, and the on-demand trail", async () => {
    const clients = fakeClients();
    renderScreen(
      clients as never,
      [{ path: "/library", element: <LibraryScreen /> }],
      "/library",
    );

    const shelf = await screen.findByRole("region", { name: "Citations on the shelf" });
    // Identity over file names: the title leads, the paper is small print.
    await within(shelf).findByText("Kesar vs State");
    expect(
      within(shelf).getByText(/Supreme Court, 2014 — AIR 2014 SC 1/),
    ).toBeInTheDocument();
    // Provenance: filed directly vs promoted from a matter.
    expect(within(shelf).getByText("Library")).toBeInTheDocument();
    expect(within(shelf).getByText("from CS/2026/042")).toBeInTheDocument();

    // The trail loads only on demand.
    expect(clients.citationUses.list).not.toHaveBeenCalled();
    await userEvent.click(
      within(shelf).getAllByRole("button", { name: "Where we used it" })[0]!,
    );
    expect(await within(shelf).findByText(/under seven years/)).toBeInTheDocument();
  });

  it("corrects the identity in place — the entry is mutable, the paper is not", async () => {
    const clients = fakeClients();
    renderScreen(
      clients as never,
      [{ path: "/library", element: <LibraryScreen /> }],
      "/library",
    );

    const shelf = await screen.findByRole("region", { name: "Citations on the shelf" });
    await within(shelf).findByText("Kesar vs State");
    await userEvent.click(within(shelf).getAllByRole("button", { name: "Edit" })[0]!);
    const nameBox = within(shelf).getByLabelText("Case name (as the firm cites it)");
    await userEvent.clear(nameBox);
    await userEvent.type(nameBox, "Kesar Singh vs State of Punjab");
    await userEvent.click(within(shelf).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(clients.citations.update).toHaveBeenCalled());
    const sent = clients.citations.update.mock.calls[0]?.[0] as {
      spec?: { title?: string; documentId?: string };
    };
    expect(sent.spec?.title).toBe("Kesar Singh vs State of Punjab");
    // The paper link rides along unchanged (the server refuses edits).
    expect(sent.spec?.documentId).toBe("doc_lib");
  });

  it("uploads through the front door with the identity beside the bytes", async () => {
    const clients = fakeClients();
    renderScreen(
      clients as never,
      [{ path: "/library", element: <LibraryScreen /> }],
      "/library",
    );

    const door = await screen.findByRole("region", { name: "Add to the library" });
    await userEvent.type(
      within(door).getByLabelText("Case name (as the firm cites it)"),
      "Arnesh Kumar vs State of Bihar",
    );
    await userEvent.type(
      within(door).getByLabelText("Citation (optional)"),
      "AIR 2014 SC 2756",
    );
    const file = new File(["%PDF-1.4 fictional judgment"], "arnesh.pdf", {
      type: "application/pdf",
    });
    await userEvent.upload(
      within(door).getByLabelText("Pick the file", { selector: "input" }),
      file,
    );
    // Picking is not filing — the visible submit is (a real form, so
    // the required case name is browser-enforced).
    expect(within(door).getByText(/Picked: arnesh\.pdf/)).toBeInTheDocument();
    await userEvent.click(within(door).getByRole("button", { name: "Add to the library" }));

    await waitFor(() =>
      expect(clients.files.uploadLibraryDocument).toHaveBeenCalledWith(file, {
        title: "Arnesh Kumar vs State of Bihar",
        court: undefined,
        year: undefined,
        citation: "AIR 2014 SC 2756",
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(/on the shelf/);
  });

  it("searches identity and page text side by side", async () => {
    const clients = fakeClients();
    renderScreen(
      clients as never,
      [{ path: "/library", element: <LibraryScreen /> }],
      "/library",
    );

    await screen.findByRole("region", { name: "Citations on the shelf" });
    await userEvent.type(screen.getByLabelText("Search the shelf"), "Kesar");

    const results = await screen.findByRole("region", { name: /Search: “Kesar”/ });
    await within(results).findByText("Kesar vs State");
    expect(clients.citations.search).toHaveBeenCalled();
    // The page-text arm fired too (two honest answers side by side).
    await waitFor(() => expect(clients.documentPages.search).toHaveBeenCalled());
  });
});
