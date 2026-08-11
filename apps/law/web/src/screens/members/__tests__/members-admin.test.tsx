/**
 * Account administration on the firm screen (DD-003 D4): the managing
 * partner onboards members and receives the shown-once activation code;
 * everyone else gets the read-only roster with no administration
 * affordances at all (the UI hides what the server would refuse).
 */

import { create } from "@bufbuild/protobuf";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConnectError, Code } from "@connectrpc/connect";
import {
  FirmMemberSchema,
  FirmRole,
  ListFirmMembersResponseSchema,
} from "../../../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import {
  IssueActivationCodeResponseSchema,
  UserSchema,
} from "../../../gen/stigmer/identity/user/v1/user_pb.js";
import { COLLEAGUE, MY_MEMBER, fakeFirmMembers, renderScreen } from "../../../test-support/render.js";
import { RosterScreen } from "../RosterScreen.js";

function fakeUsers() {
  return {
    create: vi.fn(async () =>
      create(UserSchema, { metadata: { id: "usr_new" }, spec: { email: "kiran@acme.example" } }),
    ),
    get: vi.fn(),
    issueActivationCode: vi.fn(async () =>
      create(IssueActivationCodeResponseSchema, {
        code: "act_test_code_1234",
        expiresInSeconds: 3 * 24 * 60 * 60,
      }),
    ),
  };
}

describe("RosterScreen — the managing partner's surface", () => {
  it("onboards a member: account, profile, and the shown-once code", async () => {
    const firmMembers = {
      ...fakeFirmMembers(),
      create: vi.fn(async () => create(FirmMemberSchema, { metadata: { id: "fmem_new" } })),
    };
    const users = fakeUsers();
    renderScreen(
      { firmMembers: firmMembers as never, users: users as never },
      [{ path: "/members", element: <RosterScreen /> }],
      "/members",
    );

    await userEvent.click(await screen.findByRole("button", { name: "Add member" }));
    await userEvent.type(screen.getByLabelText("Name"), "Kiran Rao");
    await userEvent.type(screen.getByLabelText("Email"), "kiran@acme.example");
    await userEvent.selectOptions(screen.getByLabelText("Role"), String(FirmRole.CLERK));
    await userEvent.click(screen.getByRole("button", { name: "Add member and get code" }));

    // The code appears exactly once, with the hand-over guidance.
    const card = await screen.findByRole("status", { name: "Activation code issued" });
    expect(card).toHaveTextContent("act_test_code_1234");
    expect(card).toHaveTextContent("will not be shown again");

    expect(users.create).toHaveBeenCalledTimes(1);
    expect(firmMembers.create).toHaveBeenCalledTimes(1);
    expect(users.issueActivationCode).toHaveBeenCalledWith({ email: "kiran@acme.example" });
  });

  it("surfaces the server's lockout sentence verbatim on a refused deactivation", async () => {
    const firmMembers = {
      ...fakeFirmMembers(),
      update: vi.fn(async () => {
        throw new ConnectError(
          "The firm must keep at least one active managing partner — assign another managing partner before changing this one",
          Code.FailedPrecondition,
        );
      }),
    };
    renderScreen(
      { firmMembers: firmMembers as never, users: fakeUsers() as never },
      [{ path: "/members", element: <RosterScreen /> }],
      "/members",
    );

    // The COLLEAGUE row (not self) carries the deactivate control.
    await userEvent.click(await screen.findByRole("button", { name: "Deactivate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /at least one active managing partner/,
    );
  });

  it("offers no deactivate control on one's own row", async () => {
    renderScreen(
      { firmMembers: fakeFirmMembers() as never, users: fakeUsers() as never },
      [{ path: "/members", element: <RosterScreen /> }],
      "/members",
    );
    // Two active members render (me + colleague); exactly ONE deactivate.
    await screen.findByText("Ravi Iyer");
    expect(screen.getAllByRole("button", { name: "Deactivate" })).toHaveLength(1);
  });
});

describe("RosterScreen — everyone else", () => {
  it("shows the read-only roster with no administration affordances", async () => {
    const firmMembers = {
      get: vi.fn(async () => COLLEAGUE), // the caller resolves to an associate
      list: vi.fn(async () =>
        create(ListFirmMembersResponseSchema, {
          items: [MY_MEMBER, COLLEAGUE],
          totalCount: 2n,
        }),
      ),
    };
    renderScreen(
      { firmMembers: firmMembers as never },
      [{ path: "/members", element: <RosterScreen /> }],
      "/members",
    );

    expect(await screen.findByText("Ravi Iyer")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Add member" })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset access" })).not.toBeInTheDocument();
    expect(
      screen.getByText(/managed by the firm's managing partner/),
    ).toBeInTheDocument();
  });
});
