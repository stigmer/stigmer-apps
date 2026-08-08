/**
 * Unit tests for the environment loader. The integration suites construct
 * BackendConfig literally and never exercise this path — but deployment
 * does, so the env-var contract (names, defaults, accumulated failure)
 * is pinned here. Pure function, no containers.
 */
import { describe, expect, it } from "vitest";
import { loadConfigFromEnv } from "../config.js";

/** A complete, valid environment — tests remove or override entries. */
function fullEnv(): Record<string, string> {
  return {
    DATABASE_URL: "postgres://law:law@localhost:5432/law",
    PORT: "9090",
    OBJECT_STORE_ENDPOINT: "http://localhost:9000",
    OBJECT_STORE_BUCKET: "test-documents",
    OBJECT_STORE_REGION: "auto",
    OBJECT_STORE_ACCESS_KEY_ID: "test-access-key",
    OBJECT_STORE_SECRET_ACCESS_KEY: "test-secret-key",
  };
}

describe("loadConfigFromEnv", () => {
  it("maps a complete environment onto the config shape", () => {
    const config = loadConfigFromEnv(fullEnv());

    expect(config).toEqual({
      databaseUrl: "postgres://law:law@localhost:5432/law",
      port: 9090,
      objectStore: {
        endpoint: "http://localhost:9000",
        bucket: "test-documents",
        region: "auto",
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key",
      },
    });
  });

  it("defaults PORT to 8080 and OBJECT_STORE_REGION to auto", () => {
    const env = fullEnv();
    delete env.PORT;
    delete env.OBJECT_STORE_REGION;

    const config = loadConfigFromEnv(env);

    expect(config.port).toBe(8080);
    expect(config.objectStore.region).toBe("auto");
  });

  it("names every missing variable in one accumulated error, not one per attempt", () => {
    // A deploy with several missing variables must fail once with all the
    // names — the operator fixes the manifest in one pass.
    expect(() => loadConfigFromEnv({})).toThrowError(
      /^Invalid backend configuration:\n- DATABASE_URL .*\n- OBJECT_STORE_ENDPOINT .*\n- OBJECT_STORE_BUCKET .*\n- OBJECT_STORE_ACCESS_KEY_ID .*\n- OBJECT_STORE_SECRET_ACCESS_KEY .*/,
    );
  });

  it("names exactly the one variable that is missing", () => {
    const env = fullEnv();
    delete env.OBJECT_STORE_BUCKET;

    expect(() => loadConfigFromEnv(env)).toThrowError(
      "Invalid backend configuration:\n- OBJECT_STORE_BUCKET is required (document storage, S3-compatible)",
    );
  });

  it("treats an empty string the same as an unset variable", () => {
    // Kubernetes renders an unresolved reference as "" — that must fail
    // loudly at boot, not surface later as a connection error.
    const env = fullEnv();
    env.DATABASE_URL = "";

    expect(() => loadConfigFromEnv(env)).toThrowError(/DATABASE_URL is required/);
  });

  it.each([
    ["not-a-number", "non-numeric"],
    ["8080.5", "non-integer"],
    ["0", "below the range"],
    ["65536", "above the range"],
  ])("rejects PORT '%s' (%s)", (portValue) => {
    const env = fullEnv();
    env.PORT = portValue;

    expect(() => loadConfigFromEnv(env)).toThrowError(
      `Invalid backend configuration:\n- PORT must be an integer in 1-65535, got '${portValue}'`,
    );
  });
});
