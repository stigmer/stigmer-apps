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

/** Long enough for the loader's 32-char floor; obviously not real. */
const MCP_SECRET = "test-mcp-shared-secret-0123456789abcdef";

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
    MCP_SHARED_SECRET: MCP_SECRET,
  };
}

describe("loadConfigFromEnv", () => {
  it("maps a complete environment onto the config shape", () => {
    const config = loadConfigFromEnv(fullEnv());

    expect(config).toEqual({
      database: { connectionString: "postgres://law:law@localhost:5432/law" },
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
      mcp: {
        port: 8081,
        sharedSecret: MCP_SECRET,
      },
    });
  });

  it("defaults PORT to 8080, MCP_PORT to 8081, and OBJECT_STORE_REGION to auto", () => {
    const env = fullEnv();
    delete env.PORT;
    delete env.OBJECT_STORE_REGION;

    const config = loadConfigFromEnv(env);

    expect(config.port).toBe(8080);
    expect(config.mcp.port).toBe(8081);
    expect(config.objectStore.region).toBe("auto");
  });

  it("names every missing variable in one accumulated error, not one per attempt", () => {
    // A deploy with several missing variables must fail once with all the
    // names — the operator fixes the manifest in one pass.
    expect(() => loadConfigFromEnv({})).toThrowError(
      /^Invalid backend configuration:\n- DATABASE_URL .*\n- OBJECT_STORE_ENDPOINT .*\n- OBJECT_STORE_BUCKET .*\n- OBJECT_STORE_ACCESS_KEY_ID .*\n- OBJECT_STORE_SECRET_ACCESS_KEY .*\n- AUTH_JWT_PRIVATE_KEY .*\n- AUTH_OPERATOR_KEY_SHA256 .*\n- MCP_SHARED_SECRET .*/,
    );
  });

  describe("the MCP entrance (T05, DD-008)", () => {
    it("refuses a short shared secret — there is no insecure mode", () => {
      const env = fullEnv();
      env.MCP_SHARED_SECRET = "too-short";

      expect(() => loadConfigFromEnv(env)).toThrowError(/MCP_SHARED_SECRET .* min 32/);
    });

    it("refuses MCP_PORT colliding with PORT — two listeners, two ports", () => {
      const env = fullEnv();
      env.MCP_PORT = env.PORT as string;

      expect(() => loadConfigFromEnv(env)).toThrowError(/MCP_PORT must differ from PORT/);
    });

    it("validates MCP_PORT like every port", () => {
      const env = fullEnv();
      env.MCP_PORT = "0";

      expect(() => loadConfigFromEnv(env)).toThrowError(/MCP_PORT/);
    });
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

    expect(() => loadConfigFromEnv(env)).toThrowError(/DATABASE_URL .* is required/);
  });

  describe("database sources (T06 — deployment passes discrete PG* values)", () => {
    /** The deployment form: discrete values instead of one URL. */
    function discreteEnv(): Record<string, string> {
      const env = fullEnv();
      delete env.DATABASE_URL;
      env.PGHOST = "db.example.internal";
      env.PGPORT = "5433";
      env.PGDATABASE = "law";
      env.PGUSER = "law_app";
      env.PGPASSWORD = "p@ss:word/needs#no?encoding";
      return env;
    }

    it("maps the discrete PG* set onto structured fields, never a composed URL", () => {
      // The password carries URL-hostile characters on purpose: fields go
      // to pg.Pool as-is, so no percent-encoding hazard can exist.
      expect(loadConfigFromEnv(discreteEnv()).database).toEqual({
        host: "db.example.internal",
        port: 5433,
        database: "law",
        user: "law_app",
        password: "p@ss:word/needs#no?encoding",
      });
    });

    it("defaults PGPORT to 5432", () => {
      const env = discreteEnv();
      delete env.PGPORT;

      expect(loadConfigFromEnv(env).database).toMatchObject({ port: 5432 });
    });

    it("refuses both sources at once — ambiguity is a config error", () => {
      const env = discreteEnv();
      env.DATABASE_URL = "postgres://law:law@localhost:5432/law";

      expect(() => loadConfigFromEnv(env)).toThrowError(/mutually exclusive/);
    });

    it("names the missing variables when the PG* set is incomplete", () => {
      const env = discreteEnv();
      delete env.PGDATABASE;
      delete env.PGPASSWORD;

      expect(() => loadConfigFromEnv(env)).toThrowError(
        /PGDATABASE, PGPASSWORD are required \(the PG\* set must be complete/,
      );
    });

    it("rejects a non-numeric PGPORT", () => {
      const env = discreteEnv();
      env.PGPORT = "not-a-number";

      expect(() => loadConfigFromEnv(env)).toThrowError(
        "Invalid backend configuration:\n- PGPORT must be an integer in 1-65535, got 'not-a-number'",
      );
    });

    it("PGSSLMODE=require encrypts without verifying — the operator's certs are self-signed", () => {
      // Verified live: the deployed operator's pg_hba rejects
      // unencrypted clients ("no encryption"), and its certs are
      // self-signed, so require = encrypt, don't verify.
      const env = discreteEnv();
      env.PGSSLMODE = "require";

      expect(loadConfigFromEnv(env).database).toMatchObject({
        ssl: { rejectUnauthorized: false },
      });
    });

    it("omits ssl entirely by default (dev/tests speak plaintext)", () => {
      expect(loadConfigFromEnv(discreteEnv()).database).not.toHaveProperty("ssl");
    });

    it("refuses PGSSLMODE values it cannot honor", () => {
      const env = discreteEnv();
      env.PGSSLMODE = "verify-full";

      expect(() => loadConfigFromEnv(env)).toThrowError(
        /PGSSLMODE must be 'disable' or 'require'/,
      );
    });
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
