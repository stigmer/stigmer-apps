/**
 * The Money tab (FR-MONEY-*, partner-only): a case with no fee
 * arrangement yet is the NORMAL starting state — the blank form must
 * render so the first arrangement can be recorded. Regression pin: the
 * fee query resolves null (not undefined) on NotFound; undefined trips
 * TanStack Query's "data is undefined" rejection and turns the blank
 * form into a dead-end error banner nothing in the UI can clear.
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  FeeArrangementSchema,
  FeeKind,
  type FeeArrangement,
} from "../../../gen/stigmer/law/feearrangement/v1/feearrangement_pb.js";
import { ListLedgerEntriesResponseSchema } from "../../../gen/stigmer/law/ledgerentry/v1/ledgerentry_pb.js";
import { renderScreen } from "../../../test-support/render.js";
import { CaseMoney } from "../CaseMoney.js";

const EXISTING = create(FeeArrangementSchema, {
  metadata: { id: "fee_1" },
  spec: {
    caseId: "case_1",
    feeKind: FeeKind.LUMP_SUM,
    lumpSumPaise: 15000000n,
    termsNote: "expenses billed at actuals",
  },
});

/** The ledger section always mounts alongside the form; keep it quiet. */
function fakeLedgerEntries() {
  return {
    list: vi.fn(async () =>
      create(ListLedgerEntriesResponseSchema, { items: [], totalCount: 0n }),
    ),
    create: vi.fn(),
  };
}

function renderMoney(feeArrangements: object) {
  renderScreen(
    {
      feeArrangements: feeArrangements as never,
      ledgerEntries: fakeLedgerEntries() as never,
    },
    [{ path: "/", element: <CaseMoney caseId="case_1" /> }],
    "/",
  );
}

describe("CaseMoney — the fee arrangement form", () => {
  it("renders the blank form when no arrangement exists yet (NotFound is the normal first visit, not an error)", async () => {
    renderMoney({
      get: vi.fn(async () => {
        throw new ConnectError("no fee arrangement for case_1", Code.NotFound);
      }),
    });

    expect(
      await screen.findByRole("button", { name: "Record arrangement" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("records the first arrangement from the blank form (the fresh-case dead-end, proven gone)", async () => {
    const feeArrangements = {
      get: vi.fn(async () => {
        throw new ConnectError("no fee arrangement for case_1", Code.NotFound);
      }),
      create: vi.fn(async (fee: FeeArrangement) => fee),
    };
    renderMoney(feeArrangements);

    await userEvent.selectOptions(await screen.findByLabelText("Agreed as"), "Lump sum");
    await userEvent.type(screen.getByLabelText("Total (₹)"), "1,50,000");
    await userEvent.click(screen.getByRole("button", { name: "Record arrangement" }));

    await waitFor(() =>
      expect(feeArrangements.create).toHaveBeenCalledWith(
        expect.objectContaining({
          spec: expect.objectContaining({
            caseId: "case_1",
            feeKind: FeeKind.LUMP_SUM,
            lumpSumPaise: 15000000n,
          }),
        }),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Arrangement saved.");
  });

  it("pre-fills from an existing arrangement and offers the update, not a second record", async () => {
    const feeArrangements = {
      get: vi.fn(async () => EXISTING),
      update: vi.fn(async (fee: FeeArrangement) => fee),
    };
    renderMoney(feeArrangements);

    expect(
      await screen.findByRole("button", { name: "Update arrangement" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Total (₹)")).toHaveValue("150000");
    expect(screen.getByLabelText(/Terms/)).toHaveValue("expenses billed at actuals");
  });

  it("still surfaces a genuine failure with a way forward (only NotFound is the normal answer)", async () => {
    renderMoney({
      get: vi.fn(async () => {
        throw new ConnectError("the service is unavailable", Code.Internal);
      }),
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("the service is unavailable");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Record arrangement" }),
    ).not.toBeInTheDocument();
  });
});
