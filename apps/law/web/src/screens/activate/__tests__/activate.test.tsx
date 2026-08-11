/**
 * Account activation (DD-003 D4): the anonymous set-your-password
 * screen. The failure path shows the server's uniform sentence
 * verbatim; success points at sign-in; the code prefills from the
 * shareable ?code= link.
 */

import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Code, ConnectError } from "@connectrpc/connect";
import { renderScreen } from "../../../test-support/render.js";
import { ActivateScreen } from "../ActivateScreen.js";

describe("ActivateScreen", () => {
  it("redeems the code and offers sign-in", async () => {
    const redeem = vi.fn(async () => undefined);
    renderScreen(
      {},
      [{ path: "/activate", element: <ActivateScreen /> }],
      "/activate",
      { session: { redeemActivationCode: redeem } },
    );

    await userEvent.type(screen.getByLabelText("Activation code"), "act_from_the_partner");
    await userEvent.type(screen.getByLabelText("Choose a password"), "my-own-passphrase");
    await userEvent.type(screen.getByLabelText("Repeat the password"), "my-own-passphrase");
    await userEvent.click(screen.getByRole("button", { name: "Set password" }));

    const confirmation = (await screen.findByText("Your password is set.")).closest(
      "[role=status]",
    ) as HTMLElement;
    expect(within(confirmation).getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login",
    );
    expect(redeem).toHaveBeenCalledWith("act_from_the_partner", "my-own-passphrase");
  });

  it("prefills the code from the shareable link", async () => {
    renderScreen(
      {},
      [{ path: "/activate", element: <ActivateScreen /> }],
      "/activate?code=act_prefilled",
    );
    expect(screen.getByLabelText("Activation code")).toHaveValue("act_prefilled");
  });

  it("catches mismatched passwords before any request", async () => {
    const redeem = vi.fn();
    renderScreen(
      {},
      [{ path: "/activate", element: <ActivateScreen /> }],
      "/activate",
      { session: { redeemActivationCode: redeem } },
    );

    await userEvent.type(screen.getByLabelText("Activation code"), "act_whatever");
    await userEvent.type(screen.getByLabelText("Choose a password"), "one-passphrase");
    await userEvent.type(screen.getByLabelText("Repeat the password"), "another-passphrase");
    await userEvent.click(screen.getByRole("button", { name: "Set password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The passwords do not match");
    expect(redeem).not.toHaveBeenCalled();
  });

  it("shows the server's uniform failure verbatim", async () => {
    renderScreen(
      {},
      [{ path: "/activate", element: <ActivateScreen /> }],
      "/activate",
      {
        session: {
          redeemActivationCode: async () => {
            throw new ConnectError("This code is not valid or has expired", Code.Unauthenticated);
          },
        },
      },
    );

    await userEvent.type(screen.getByLabelText("Activation code"), "act_stale");
    await userEvent.type(screen.getByLabelText("Choose a password"), "my-own-passphrase");
    await userEvent.type(screen.getByLabelText("Repeat the password"), "my-own-passphrase");
    await userEvent.click(screen.getByRole("button", { name: "Set password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This code is not valid or has expired",
    );
  });
});
