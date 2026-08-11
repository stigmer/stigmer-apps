/**
 * OpenFGA test harness — one container per suite, the postgres
 * testcontainers discipline applied to the authorization engine. Runs
 * with preshared-key authentication ON because that is how every
 * deployment runs (an open engine endpoint is forbidden — hostile-
 * adjacent cluster networks; project DD-003 D1) and tests must exercise
 * the authenticated path, not a friendlier one.
 *
 * Published under the `./testing` subpath so consuming apps' test
 * suites can share it without `testcontainers` entering any production
 * bundle.
 */

import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import type { OpenFgaConnection } from "./bootstrap.js";

// Pinned tag, not `latest`: engine behavior must not change under us
// between runs. Bump deliberately, alongside the deploy chart's pin.
const OPENFGA_IMAGE = "openfga/openfga:v1.18.3";
const HTTP_PORT = 8080;

export interface TestAuthorizationServer {
  readonly container: StartedTestContainer;
  readonly connection: OpenFgaConnection;
  stop(): Promise<void>;
}

export async function startTestAuthorizationServer(): Promise<TestAuthorizationServer> {
  // 32+ chars: consuming apps are entitled to enforce a length floor on
  // preshared keys, and the harness must clear it.
  const apiToken = `test_fga_key_${Math.random().toString(36).slice(2)}`.padEnd(40, "0");
  const container = await new GenericContainer(OPENFGA_IMAGE)
    .withCommand(["run"])
    .withEnvironment({
      // In-memory datastore: each suite starts empty and isolated; the
      // Postgres-backed engine is a deployment concern, not a model-
      // semantics concern.
      OPENFGA_DATASTORE_ENGINE: "memory",
      OPENFGA_AUTHN_METHOD: "preshared",
      OPENFGA_AUTHN_PRESHARED_KEYS: apiToken,
      OPENFGA_PLAYGROUND_ENABLED: "false",
    })
    .withExposedPorts(HTTP_PORT)
    // /healthz is served before authn, so it is the readiness signal
    // even with preshared keys enabled.
    .withWaitStrategy(Wait.forHttp("/healthz", HTTP_PORT).forStatusCode(200))
    .start();

  return {
    container,
    connection: {
      apiUrl: `http://${container.getHost()}:${container.getMappedPort(HTTP_PORT)}`,
      apiToken,
    },
    async stop() {
      await container.stop();
    },
  };
}
