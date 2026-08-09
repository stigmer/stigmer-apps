/**
 * Composition root: the session kit and the two transports are built
 * once, here, and everything else receives them — screens never construct
 * their own data access (T04b D2/D4).
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAppRouter } from "./app.js";
import { ApiClientsProvider, createApiClients } from "./api/clients.js";
import { createFilesClient } from "./api/files.js";
import { createApiTransport, createAuthTransport } from "./api/transport.js";
import { createSessionKit } from "./session/session.js";
import { browserTabCoordination } from "./session/tab-coordination.js";
import { SessionProvider } from "./session/use-session.js";
import "./styles/app.css";

// Same origin as the API — the backend serves this app (D1).
const baseUrl = window.location.origin;

const session = createSessionKit({
  authTransport: createAuthTransport(baseUrl),
  coordination: browserTabCoordination(),
});
const clients = createApiClients(
  createApiTransport(baseUrl, session),
  createFilesClient(baseUrl, session),
);

const queryClient = new QueryClient();

const root = document.getElementById("root");
if (!root) {
  throw new Error("index.html carries no #root element");
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider kit={session}>
        <ApiClientsProvider clients={clients}>
          <RouterProvider router={createAppRouter()} />
        </ApiClientsProvider>
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
