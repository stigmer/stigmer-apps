/**
 * The case Citations tab (DD-012 D2): the matter's reliance trail and
 * the case-first citing flow — search the firm's shelf, pick the
 * precedent, state the proposition. The flow the library-only entry
 * point inverted: a lawyer cites FROM the matter they are working.
 */

import { create } from "@bufbuild/protobuf";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  CitationSchema,
  SearchCitationsResponseSchema,
} from "../../../gen/stigmer/law/citation/v1/citation_pb.js";
import {
  CitationUseSchema,
  ListCitationUsesResponseSchema,
} from "../../../gen/stigmer/law/citationuse/v1/citationuse_pb.js";
import { renderScreen } from "../../../test-support/render.js";
import { CaseCitations } from "../CaseCitations.js";

const SHELF_ENTRY = create(CitationSchema, {
  metadata: { id: "cit_1" },
  spec: {
    documentId: "doc_lib",
    title: "Arnesh Kumar vs State of Bihar",
    court: "Supreme Court",
    year: 2014,
    citation: "AIR 2014 SC 2756",
  },
  status: { documentFileName: "arnesh.pdf" },
});

function fakeClients(trailItems = 0) {
  return {
    citationUses: {
      list: vi.fn(async () =>
        create(ListCitationUsesResponseSchema, {
          items:
            trailItems > 0
              ? [
                  create(CitationUseSchema, {
                    metadata: { id: "cuse_1" },
                    spec: {
                      documentId: "doc_lib",
                      caseId: "case_1",
                      proposition: "bail where the offence carries under seven years",
                    },
                    status: {
                      caseFileNumber: "CS/2026/042",
                      documentFileName: "arnesh.pdf",
                    },
                  }),
                ]
              : [],
          totalCount: BigInt(trailItems),
        }),
      ),
      create: vi.fn(async (use: unknown) => use),
    },
    citations: {
      search: vi.fn(async () =>
        create(SearchCitationsResponseSchema, { items: [SHELF_ENTRY] }),
      ),
    },
  };
}

describe("CaseCitations (the case-first citing flow, DD-012 D2)", () => {
  it("lists the matter's trail — the paper and its proposition", async () => {
    const clients = fakeClients(1);
    renderScreen(
      clients as never,
      [{ path: "/", element: <CaseCitations caseId="case_1" /> }],
      "/",
    );

    const tab = await screen.findByRole("region", { name: "Citations" });
    await within(tab).findByText("arnesh.pdf");
    expect(within(tab).getByText(/under seven years/)).toBeInTheDocument();
  });

  it("cites from the shelf: search, pick, proposition, recorded", async () => {
    const clients = fakeClients(0);
    renderScreen(
      clients as never,
      [{ path: "/", element: <CaseCitations caseId="case_1" /> }],
      "/",
    );

    await userEvent.click(await screen.findByRole("button", { name: "Cite a judgment" }));
    await userEvent.type(
      screen.getByLabelText(/Find it on the firm's shelf/),
      "Arnesh",
    );
    // The hit leads with the identity, not the file name.
    await screen.findByText("Arnesh Kumar vs State of Bihar");
    await userEvent.click(screen.getByRole("button", { name: "Cite this" }));
    await userEvent.type(
      screen.getByLabelText("For what proposition"),
      "bail where the offence carries under seven years",
    );
    await userEvent.click(screen.getByRole("button", { name: "Record the citation" }));

    await waitFor(() => expect(clients.citationUses.create).toHaveBeenCalled());
    const sent = clients.citationUses.create.mock.calls[0]?.[0] as {
      spec?: { documentId?: string; caseId?: string; proposition?: string };
    };
    expect(sent.spec?.documentId).toBe("doc_lib");
    expect(sent.spec?.caseId).toBe("case_1");
    expect(sent.spec?.proposition).toBe("bail where the offence carries under seven years");
  });
});
