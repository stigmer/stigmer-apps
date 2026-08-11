/**
 * Self-service password change on the profile (DD-003 D4): proof of
 * possession, mismatch caught locally, server sentences verbatim.
 */

import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Code, ConnectError } from "@connectrpc/connect";
import { renderScreen } from "../../../test-support/render.js";
import { ProfileScreen } from "../ProfileScreen.js";

async function fill(current: string, next: string, confirm: string) {
  for (const [label, value] of [
    ["Current password", current],
    ["New password", next],
    ["Repeat the new password", confirm],
  ] as const) {
    const input = screen.getByLabelText(label);
    await userEvent.clear(input);
    await userEvent.type(input, value);
  }
  await userEvent.click(screen.getByRole("button", { name: "Change password" }));
}

describe("ProfileScreen — change password", () => {
  it("changes the password through the session kit and confirms", async () => {
    const changePassword = vi.fn(async () => undefined);
    renderScreen(
      {},
      [{ path: "/profile", element: <ProfileScreen /> }],
      "/profile",
      { session: { changePassword } },
    );

    await fill("old-passphrase", "new-passphrase", "new-passphrase");

    expect(await screen.findByRole("status")).toHaveTextContent("Your password is changed.");
    expect(changePassword).toHaveBeenCalledWith("old-passphrase", "new-passphrase");
  });

  it("catches a mismatch locally and shows the wrong-current-password sentence verbatim", async () => {
    const changePassword = vi.fn(async () => {
      throw new ConnectError("The current password is incorrect", Code.PermissionDenied);
    });
    renderScreen(
      {},
      [{ path: "/profile", element: <ProfileScreen /> }],
      "/profile",
      { session: { changePassword } },
    );

    await fill("old-passphrase", "new-passphrase", "different-passphrase");
    expect(await screen.findByRole("alert")).toHaveTextContent("The new passwords do not match");
    expect(changePassword).not.toHaveBeenCalled();

    await fill("wrong-passphrase", "new-passphrase", "new-passphrase");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The current password is incorrect",
    );
  });
});
