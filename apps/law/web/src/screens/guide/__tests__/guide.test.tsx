/**
 * The Guide's two contracts: every real firm role is described (the
 * drift guard — the page and the FirmRole enum cannot silently
 * diverge), and the reader's own role is the one marked "Your role".
 * The filing-by-chat capability line is pinned because the demo and
 * the agent's instructions both lean on it staying true — it flipped
 * from an honest "cannot" to a capability when stigmer/stigmer#532
 * landed and the attach_document verb shipped.
 */

import { create } from "@bufbuild/protobuf";
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  FirmMemberSchema,
  FirmRole,
} from "../../../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import { firmRoleLabel } from "../../../lib/format.js";
import { fakeFirmMembers, renderScreen } from "../../../test-support/render.js";
import { GuideScreen } from "../GuideScreen.js";
import { GUIDE_ROLES, ROLE_GUIDE } from "../role-guide.js";

/** Every real role in the generated enum, computed from the enum
 * itself so a proto change is what fails this test. */
const REAL_ROLES = Object.values(FirmRole).filter(
  (value): value is FirmRole =>
    typeof value === "number" && value !== FirmRole.UNSPECIFIED,
);

describe("GuideScreen", () => {
  it("describes every firm role the proto defines (drift guard)", async () => {
    renderScreen(
      { firmMembers: fakeFirmMembers() } as never,
      [{ path: "/guide", element: <GuideScreen /> }],
      "/guide",
    );

    // The ordered list and the described set must both cover the enum:
    // ROLE_GUIDE's coverage is compile-time checked, GUIDE_ROLES is the
    // render order and could silently drop a row without this.
    expect([...GUIDE_ROLES].sort()).toEqual([...REAL_ROLES].sort());
    for (const role of REAL_ROLES) {
      expect(ROLE_GUIDE[role as keyof typeof ROLE_GUIDE]).toBeDefined();
      expect(await screen.findByText(firmRoleLabel(role))).toBeInTheDocument();
    }
  });

  it("marks the caller's own role — and only theirs (managing partner fixture)", async () => {
    renderScreen(
      { firmMembers: fakeFirmMembers() } as never,
      [{ path: "/guide", element: <GuideScreen /> }],
      "/guide",
    );

    const badges = await screen.findAllByText("Your role");
    expect(badges).toHaveLength(1);
    const row = badges[0]?.closest("li");
    expect(row && within(row).getByText("Managing partner")).toBeInTheDocument();
  });

  it("marks a clerk caller's row when the caller is a clerk", async () => {
    const clerk = create(FirmMemberSchema, {
      metadata: { id: "fmem_clerk" },
      spec: { userId: "usr_me", role: FirmRole.CLERK, active: true },
    });
    renderScreen(
      { firmMembers: { ...fakeFirmMembers(), get: vi.fn(async () => clerk) } } as never,
      [{ path: "/guide", element: <GuideScreen /> }],
      "/guide",
    );

    const badge = await screen.findByText("Your role");
    const row = badge.closest("li");
    expect(row && within(row).getByText("Clerk")).toBeInTheDocument();
  });

  it("claims the filing-by-chat capability, honestly bounded (the demo leans on it)", () => {
    renderScreen(
      { firmMembers: fakeFirmMembers() } as never,
      [{ path: "/guide", element: <GuideScreen /> }],
      "/guide",
    );

    // The capability, with its confirm-before-write shape…
    expect(
      screen.getByText(/file a paper you send it/i),
    ).toBeInTheDocument();
    // …and the honest limits that remain.
    expect(
      screen.getByText(/cannot read scanned documents on file/i),
    ).toBeInTheDocument();
  });
});
