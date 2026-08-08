/**
 * Unit tests for the environment loader. The integration suites construct
 * BackendConfig literally and never exercise this path — but deployment
 * does, so the env-var contract (names, defaults, accumulated failure)
 * is pinned here. Pure function, no containers.
 */
import { describe, expect, it } from "vitest";
import { loadConfigFromEnv } from "../config.js";

/** Any 64-hex string is hash-shaped enough for the loader. */
const OPERATOR_KEY_HASH = "a".repeat(64);

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
    AUTH_JWT_PRIVATE_KEY: "bm90LWEtcmVhbC1rZXk=",
    AUTH_OPERATOR_KEY_SHA256: OPERATOR_KEY_HASH,
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
      auth: {
        ephemeralKeys: false,
        privateKeyBase64: "bm90LWEtcmVhbC1rZXk=",
        previousPublicKeyBase64: undefined,
        operatorKeySha256Hex: OPERATOR_KEY_HASH,
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
      /^Invalid backend configuration:\n- DATABASE_URL .*\n- OBJECT_STORE_ENDPOINT .*\n- OBJECT_STORE_BUCKET .*\n- OBJECT_STORE_ACCESS_KEY_ID .*\n- OBJECT_STORE_SECRET_ACCESS_KEY .*\n- AUTH_JWT_PRIVATE_KEY .*\n- AUTH_OPERATOR_KEY_SHA256 .*/,
    );
  });

  describe("auth (DD-005 D4/D7)", () => {
    it("accepts ephemeral keys as the dev/test alternative to a configured key", () => {
      const env = fullEnv();
      delete env.AUTH_JWT_PRIVATE_KEY;
      env.AUTH_EPHEMERAL_KEYS = "true";

      expect(loadConfigFromEnv(env).auth.ephemeralKeys).toBe(true);
    });

    it("refuses ephemeral keys alongside a configured key — ambiguity is a config error", () => {
      const env = fullEnv();
      env.AUTH_EPHEMERAL_KEYS = "true";

      expect(() => loadConfigFromEnv(env)).toThrowError(/mutually exclusive/);
    });

    it("production fails fast without signing keys (no silent ephemeral fallback)", () => {
      const env = fullEnv();
      delete env.AUTH_JWT_PRIVATE_KEY;

      expect(() => loadConfigFromEnv(env)).toThrowError(/AUTH_JWT_PRIVATE_KEY is required/);
    });

    it("requires a hash-shaped operator key digest", () => {
      const env = fullEnv();
      env.AUTH_OPERATOR_KEY_SHA256 = "opk_raw-key-not-a-hash";

      expect(() => loadConfigFromEnv(env)).toThrowError(/AUTH_OPERATOR_KEY_SHA256/);
    });

    it("carries the rotation overlap key through when present", () => {
      const env = fullEnv();
      env.AUTH_JWT_PREVIOUS_PUBLIC_KEY = "cHJldi1rZXk=";

      expect(loadConfigFromEnv(env).auth.previousPublicKeyBase64).toBe("cHJldi1rZXk=");
    });
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
