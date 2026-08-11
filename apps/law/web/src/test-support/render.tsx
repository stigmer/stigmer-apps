/**
 * The component-test harness: real providers, faked client surface (the
 * ApiClients context is the seam — screens never construct transports).
 * Every suite renders through here so the provider stack cannot drift
 * between tests and the app.
 */

import { create } from "@bufbuild/protobuf";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { vi } from "vitest";
import { ApiClientsProvider, type ApiClients } from "../api/clients.js";
import {
  FirmMemberSchema,
  FirmRole,
  ListFirmMembersResponseSchema,
  type FirmMember,
} from "../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import { UserSchema, type User } from "../gen/stigmer/identity/user/v1/user_pb.js";
import type { SessionKit } from "../session/session.js";
import { SessionProvider } from "../session/use-session.js";

export const ME: User = create(UserSchema, {
  metadata: { id: "usr_me" },
  spec: { email: "asha@acme.example", name: "Asha Rao" },
});

/** My firm profile — the id task assignments and person refs carry. */
export const MY_MEMBER: FirmMember = create(FirmMemberSchema, {
  metadata: { id: "fmem_me" },
  spec: { userId: "usr_me", role: FirmRole.MANAGING_PARTNER, active: true },
  status: { userName: "Asha Rao", userEmail: "asha@acme.example" },
});

export const COLLEAGUE: FirmMember = create(FirmMemberSchema, {
  metadata: { id: "fmem_ravi" },
  spec: { userId: "usr_ravi", role: FirmRole.ASSOCIATE, active: true },
  status: { userName: "Ravi Iyer", userEmail: "ravi@acme.example" },
});

/** The roster + profile fakes nearly every screen needs (people pickers,
 * author names, the caller's role). */
export function fakeFirmMembers() {
  return {
    get: vi.fn(async () => MY_MEMBER),
    list: vi.fn(async () =>
      create(ListFirmMembersResponseSchema, {
        items: [MY_MEMBER, COLLEAGUE],
        totalCount: 2n,
      }),
    ),
  };
}

function fakeSessionKit(overrides?: Partial<SessionKit>): SessionKit {
  // Stable snapshot reference — useSyncExternalStore loops on a getState
  // that manufactures a new object per call (the same reason the real
  // kit holds one state object between transitions).
  const state = { status: "signed-in", user: ME } as const;
  return {
    getState: () => state,
    subscribe: () => () => undefined,
    bootstrap: async () => undefined,
    signIn: async () => undefined,
    signOut: async () => undefined,
    getAccessToken: async () => "tok_test",
    invalidateAccessToken: () => undefined,
    redeemActivationCode: async () => undefined,
    changePassword: async () => undefined,
    ...overrides,
  };
}

/** Screens under the real providers, with the client surface faked. */
export function renderScreen(
  clients: Partial<ApiClients>,
  routes: { path: string; element: ReactNode }[],
  initialPath: string,
  options?: { session?: Partial<SessionKit> },
) {
  const router = createMemoryRouter(
    routes.map((r) => ({ path: r.path, element: r.element })),
    { initialEntries: [initialPath] },
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SessionProvider kit={fakeSessionKit(options?.session)}>
        <ApiClientsProvider clients={clients as ApiClients}>
          <RouterProvider router={router} />
        </ApiClientsProvider>
      </SessionProvider>
    </QueryClientProvider>,
  );
  return router;
}
