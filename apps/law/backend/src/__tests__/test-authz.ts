/**
 * Shared FGA engine for a test file: ONE OpenFGA container per suite
 * (the postgres-container discipline), with fresh isolated stores on
 * demand — a store per suite for server tests, a store per test for the
 * policy matrix, all carrying the law model. Preshared-key auth is ON,
 * as everywhere (DD-003 D1).
 */

import { bootstrapAuthorization, type AuthorizationEngine } from "@stigmer/authorization";
import {
  startTestAuthorizationServer,
  type TestAuthorizationServer,
} from "@stigmer/authorization/testing";
import { LAW_AUTHZ_MODEL_DSL } from "../domain/authz/model.js";

export interface TestAuthz {
  readonly server: TestAuthorizationServer;
  /** A fresh, empty engine bound to its own store on the shared container. */
  newEngine(): Promise<AuthorizationEngine>;
  stop(): Promise<void>;
}

export async function startTestAuthz(): Promise<TestAuthz> {
  const server = await startTestAuthorizationServer();
  let storeCounter = 0;
  return {
    server,
    async newEngine() {
      storeCounter += 1;
      const { engine } = await bootstrapAuthorization({
        connection: server.connection,
        storeName: `law_test_${storeCounter}`,
        modelDsl: LAW_AUTHZ_MODEL_DSL,
      });
      return engine;
    },
    async stop() {
      await server.stop();
    },
  };
}
