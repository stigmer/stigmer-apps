/**
 * React binding for the session kit: one provider, one subscription
 * (useSyncExternalStore over the kit's listener seam), and a
 * signed-in-scoped hook so screens inside the shell never handle the
 * "what if nobody is signed in" case the router already handled.
 */

import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { User } from "../gen/stigmer/identity/user/v1/user_pb.js";
import type { SessionKit, SessionState } from "./session.js";

const SessionContext = createContext<SessionKit | undefined>(undefined);

export function SessionProvider(props: { kit: SessionKit; children: ReactNode }) {
  useEffect(() => {
    // Resume from the refresh cookie exactly once per app load; StrictMode
    // double-invocation is harmless (the second boot finds a fresh token
    // and only re-runs WhoAmI).
    void props.kit.bootstrap();
  }, [props.kit]);
  return <SessionContext.Provider value={props.kit}>{props.children}</SessionContext.Provider>;
}

export function useSessionKit(): SessionKit {
  const kit = useContext(SessionContext);
  if (!kit) {
    throw new Error("useSessionKit must be used within <SessionProvider> — wrap the app in it (src/main.tsx)");
  }
  return kit;
}

export function useSessionState(): SessionState {
  const kit = useSessionKit();
  return useSyncExternalStore(kit.subscribe, kit.getState, kit.getState);
}

/** The signed-in user — for screens the router only renders when signed in. */
export function useCurrentUser(): User {
  const state = useSessionState();
  if (state.status !== "signed-in") {
    throw new Error("useCurrentUser outside a signed-in session — screens using it must sit behind RequireSession");
  }
  return state.user;
}
