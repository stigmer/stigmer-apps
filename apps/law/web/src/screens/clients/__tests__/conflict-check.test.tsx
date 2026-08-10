/**
 * The conflict check (FR-CLIENT-003): ONE search answers both sides —
 * matched clients AND matters where the name is opposite us — and a
 * no-hits answer says so out loud (silence would read as "didn't run").
 */

import { create } from "@bufbuild/protobuf";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ClientSchema,
  OpposingPartyHitSchema,
  SearchClientsResponseSchema,
} from "../../../gen/stigmer/law/client/v1/client_pb.js";
import { renderScreen } from "../../../test-support/render.js";
import { ConflictSearchResults } from "../ClientListScreen.js";

describe("ConflictSearchResults (FR-CLIENT-003)", () => {
  it("renders matched clients AND opposing-party hits with their matters", async () => {
    const clients = {
      search: vi.fn(async () =>
        create(SearchClientsResponseSchema, {
          clients: [
            create(ClientSchema, {
              metadata: { id: "client_1" },
              spec: { displayName: "Meridian Textiles" },
            }),
          ],
          opposingPartyHits: [
            create(OpposingPartyHitSchema, {
              caseId: "case_9",
              fileNumber: "CS/2026/009",
              matchedPartyName: "Meridian Marbles",
              caption: "S. Raghavan vs Meridian Marbles",
            }),
          ],
        }),
      ),
    };
    renderScreen(
      { clients: clients as never },
      [{ path: "/", element: <ConflictSearchResults query="meridian" /> }],
      "/",
    );

    expect(await screen.findByText("Meridian Textiles")).toBeInTheDocument();
    // The other side renders as a warning with the matter it comes from.
    const otherSide = screen.getByRole("region", {
      name: "Matters where this name is on the other side",
    });
    expect(otherSide).toHaveTextContent("Meridian Marbles");
    expect(otherSide).toHaveTextContent("CS/2026/009");
    expect(clients.search).toHaveBeenCalledWith({ query: "meridian" });
  });

  it("says plainly when nothing matches — on both sides", async () => {
    const clients = {
      search: vi.fn(async () =>
        create(SearchClientsResponseSchema, { clients: [], opposingPartyHits: [] }),
      ),
    };
    renderScreen(
      { clients: clients as never },
      [{ path: "/", element: <ConflictSearchResults query="nobody" /> }],
      "/",
    );

    expect(
      await screen.findByText("No client with this name in the register."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No earlier matter with this name on the other side."),
    ).toBeInTheDocument();
  });
});
