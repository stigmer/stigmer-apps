/**
 * The User resource end to end, standalone: real Postgres (this package's
 * own migrations), real bearer tokens through the real caller resolver —
 * the exact composition a consuming app performs, exercised here so the
 * commons is proven without any product in sight (DD-A1).
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import type pg from "pg";
import type { AuthorizationPolicy } from "@stigmer/resource-api";
import { ALLOW, deny } from "@stigmer/resource-api";
import { PostgresResourceStore, runMigrations } from "@stigmer/resource-api/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bearerTokenAuthenticator,
  composeAuthenticators,
  operatorKeyAuthenticator,
} from "../../authenticator.js";
import {
  createCallerIdentityResolver,
  WHATSAPP_PHONE_KIND,
} from "../../caller-identity.js";
import { UserSchema, UserService } from "../../gen/stigmer/identity/user/v1/user_pb.js";
import { generateEphemeralSigningKeys } from "../../keys.js";
import { generateOperatorKey } from "../../operator-key.js";
import { verifyPassword } from "../../password.js";
import { generateRefreshToken, REFRESH_TOKEN_TTL_SECONDS } from "../../refresh-token.js";
import { createAccessTokenIssuer, type AccessTokenIssuer } from "../../token.js";
import { createCallerResolver } from "../../transport.js";
import { userResource } from "../../user-resource.js";
import { identityStoreKinds } from "../kind-config.js";
import {
  createPgActivationCodeStore,
  createPgCredentialStore,
  createPgRefreshTokenStore,
} from "../stores.js";
import { startTestDatabase, type TestDatabase } from "./testcontainers.js";

const MIGRATIONS_DIR = new URL("../../../migrations", import.meta.url).pathname;

/**
 * The convention consuming apps encode in their policy module: user
 * provisioning, profile corrections, and password reset are operator
 * actions — update included, because spec.phone is a channel binding
 * (see the proto's Update comment). Everything else is any-authenticated
 * (the first consumer's MVP policy).
 */
const operatorOnlyUserWrites: AuthorizationPolicy = {
  authorize({ caller, operation }) {
    if (!caller) return deny("Authentication required");
    if (operation === "create" || operation === "update" || operation === "setPassword") {
      return caller.kind === "operator"
        ? ALLOW
        : deny("Only an operator may manage user accounts");
    }
    return ALLOW;
  },
};

let db: TestDatabase;
let pool: pg.Pool;
let issuer: AccessTokenIssuer;
let operatorKey: string;
let client: ReturnType<typeof makeClient>;
let refreshTokens: ReturnType<typeof createPgRefreshTokenStore>;
let activationCodes: ReturnType<typeof createPgActivationCodeStore>;
let credentials: ReturnType<typeof createPgCredentialStore>;

function makeClient() {
  const resolver = createCallerResolver([
    operatorKeyAuthenticator(generatedOperator.sha256Hex),
    bearerTokenAuthenticator(issuer),
  ]);
  const resource = userResource({
    store: new PostgresResourceStore(pool, identityStoreKinds()),
    policy: operatorOnlyUserWrites,
    caller: resolver.fromConnect,
    credentials,
    refreshTokens,
    activationCodes,
  });
  return createClient(UserService, createRouterTransport(resource.routes));
}

const generatedOperator = generateOperatorKey();

const asBearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

function userInput(email: string, phone?: string) {
  return create(UserSchema, { spec: { email, name: "", phone } });
}

async function expectCode(promise: Promise<unknown>, code: Code, pattern?: RegExp) {
  try {
    await promise;
    expect.fail(`expected ConnectError ${Code[code]}, got success`);
  } catch (err) {
    const cerr = ConnectError.from(err);
    expect(cerr.code, cerr.message).toBe(code);
    if (pattern) expect(cerr.message).toMatch(pattern);
  }
}

beforeAll(async () => {
  db = await startTestDatabase();
  pool = await db.createIsolatedPool();
  await runMigrations(pool, [{ source: "identity", dir: MIGRATIONS_DIR }]);
  issuer = createAccessTokenIssuer(await generateEphemeralSigningKeys());
  operatorKey = generatedOperator.key;
  credentials = createPgCredentialStore(pool);
  refreshTokens = createPgRefreshTokenStore(pool);
  activationCodes = createPgActivationCodeStore(pool);
  client = makeClient();
}, 120_000);

afterAll(async () => {
  await db.stop();
});

describe("User on the commons pipeline (identity edition)", () => {
  it("operator creates; email normalizes; name defaults to the local-part", async () => {
    const created = await client.create(
      userInput("First.Clerk@Firm.example"),
      asBearer(operatorKey),
    );

    expect(created.metadata?.id).toMatch(/^user_/);
    expect(created.apiVersion).toBe("identity.stigmer.ai/v1");
    expect(created.spec?.email).toBe("first.clerk@firm.example");
    expect(created.spec?.name).toBe("first.clerk");
    expect(created.metadata?.createdBy?.id).toBe("operator");
  });

  it("a user-kind bearer token cannot create users or set passwords", async () => {
    const token = await issuer.issue("user_someone");

    await expectCode(
      client.create(userInput("intruder@firm.example"), asBearer(token)),
      Code.PermissionDenied,
      /operator/i,
    );
    await expectCode(
      client.setPassword(
        { email: "first.clerk@firm.example", password: "long-enough-pw" },
        asBearer(token),
      ),
      Code.PermissionDenied,
    );
  });

  it("INVARIANT: no transport credential reaches a system-only branch", async () => {
    // A policy branch that only the system principal may pass — the
    // "Notifications are system-written" shape. Every credential this
    // package can mint must be refused.
    const systemOnly: AuthorizationPolicy = {
      authorize({ caller }) {
        if (!caller) return deny("Authentication required");
        return caller.kind === "system" ? ALLOW : deny("system-only");
      },
    };
    const resolver = createCallerResolver([
      operatorKeyAuthenticator(generatedOperator.sha256Hex),
      bearerTokenAuthenticator(issuer),
    ]);
    const guarded = userResource({
      store: new PostgresResourceStore(pool, identityStoreKinds()),
      policy: systemOnly,
      caller: resolver.fromConnect,
      credentials,
      refreshTokens,
      activationCodes,
    });
    const guardedClient = createClient(
      UserService,
      createRouterTransport(guarded.routes),
    );

    await expectCode(
      guardedClient.create(userInput("sys@firm.example"), asBearer(operatorKey)),
      Code.PermissionDenied,
      /system-only/,
    );
    await expectCode(
      guardedClient.create(userInput("sys@firm.example"), asBearer(await issuer.issue("system"))),
      Code.PermissionDenied,
      /system-only/,
    );
  });

  it("duplicate emails answer ALREADY_EXISTS even re-cased", async () => {
    await client.create(userInput("dup@firm.example"), asBearer(operatorKey));
    await expectCode(
      client.create(userInput("DUP@firm.example"), asBearer(operatorKey)),
      Code.AlreadyExists,
      /dup@firm\.example/,
    );
  });

  it("get by email is case-insensitive; unauthenticated is refused", async () => {
    const token = await issuer.issue("user_reader");
    const fetched = await client.get({ email: "First.Clerk@firm.example" }, asBearer(token));
    expect(fetched.spec?.email).toBe("first.clerk@firm.example");

    await expectCode(client.get({ email: "first.clerk@firm.example" }), Code.Unauthenticated);
    await expectCode(
      client.get({ email: "first.clerk@firm.example" }, asBearer("Bearer garbage")),
      Code.Unauthenticated,
    );
  });

  it("setPassword bcrypts into the credential store AND revokes sessions (D9)", async () => {
    const created = await client.create(
      userInput("departing@firm.example"),
      asBearer(operatorKey),
    );
    const userId = created.metadata?.id as string;

    // The departing employee holds a live refresh session.
    const session = generateRefreshToken();
    await refreshTokens.insert(userId, session.sha256Hex, new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000));

    await client.setPassword(
      { email: "departing@firm.example", password: "new-password-1" },
      asBearer(operatorKey),
    );

    const hash = await credentials.getPasswordHash(userId);
    expect(hash).toBeDefined();
    expect(await verifyPassword("new-password-1", hash as string)).toBe(true);
    // The reset killed the session — the offboarding lever works.
    expect(await refreshTokens.consume(session.sha256Hex)).toEqual({ outcome: "invalid" });
  });

  it("list orders by email and paginates with a total count", async () => {
    const token = await issuer.issue("user_reader");
    const page = await client.list({ pageSize: 2 }, asBearer(token));

    expect(page.items.length).toBe(2);
    expect(Number(page.totalCount)).toBeGreaterThanOrEqual(3);
    const emails = page.items.map((u) => u.spec?.email ?? "");
    expect([...emails].sort()).toEqual(emails);
  });

  it("phone must be strict E.164 when present", async () => {
    await expectCode(
      client.create(userInput("phone@firm.example", "0044 123"), asBearer(operatorKey)),
      Code.InvalidArgument,
    );
    const ok = await client.create(
      userInput("phone@firm.example", "+91123456"),
      asBearer(operatorKey),
    );
    expect(ok.spec?.phone).toBe("+91123456");
  });

  describe("update (the T05 deferral, cashed: profile corrections exist)", () => {
    /** Full-spec replacement input targeting an existing user by id. */
    function updateInput(
      id: string,
      spec: { email: string; name?: string; phone?: string },
    ) {
      return create(UserSchema, { metadata: { id }, spec });
    }

    it("operator corrects name and phone; audit and version advance, createdBy survives", async () => {
      const created = await client.create(
        userInput("correctable@firm.example", "+91123460"),
        asBearer(operatorKey),
      );
      const id = created.metadata?.id as string;

      const updated = await client.update(
        updateInput(id, {
          email: "correctable@firm.example",
          name: "Asha V.",
          phone: "+91123461",
        }),
        asBearer(operatorKey),
      );

      expect(updated.spec?.name).toBe("Asha V.");
      expect(updated.spec?.phone).toBe("+91123461");
      expect(updated.metadata?.version).toBe(2n);
      expect(updated.metadata?.createdBy?.id).toBe("operator");
      expect(updated.metadata?.updatedBy?.id).toBe("operator");
    });

    it("a user-kind bearer token cannot update — even for a benign name fix (the convention's boundary)", async () => {
      const created = await client.create(
        userInput("untouchable@firm.example"),
        asBearer(operatorKey),
      );
      await expectCode(
        client.update(
          updateInput(created.metadata?.id as string, {
            email: "untouchable@firm.example",
            name: "New Name",
          }),
          asBearer(await issuer.issue("user_someone")),
        ),
        Code.PermissionDenied,
        /operator/i,
      );
    });

    it("the caller resolver follows the write: a phone set by update resolves, a phone omitted un-resolves", async () => {
      // The reason Update exists at all (T05): the resolver reads the
      // GENERATED phone column, so an update IS a channel re-binding.
      const resolve = createCallerIdentityResolver(
        new PostgresResourceStore(pool, identityStoreKinds()),
      );
      const created = await client.create(
        userInput("rebindable@firm.example"),
        asBearer(operatorKey),
      );
      const id = created.metadata?.id as string;

      expect((await resolve({ kind: WHATSAPP_PHONE_KIND, value: "91123470" })).outcome).toBe(
        "unknown",
      );

      await client.update(
        updateInput(id, { email: "rebindable@firm.example", phone: "+91123470" }),
        asBearer(operatorKey),
      );
      const bound = await resolve({ kind: WHATSAPP_PHONE_KIND, value: "91123470" });
      expect(bound.outcome).toBe("resolved");
      if (bound.outcome === "resolved") expect(bound.principal.id).toBe(id);

      // Full-spec replacement: omitting phone clears the binding — the
      // number-offboarding path, and the sharp edge the docs warn about.
      await client.update(
        updateInput(id, { email: "rebindable@firm.example" }),
        asBearer(operatorKey),
      );
      expect((await resolve({ kind: WHATSAPP_PHONE_KIND, value: "91123470" })).outcome).toBe(
        "unknown",
      );
    });

    it("update enforces the same E.164 validation and normalizes a re-cased email onto itself", async () => {
      const created = await client.create(
        userInput("recase@firm.example"),
        asBearer(operatorKey),
      );
      const id = created.metadata?.id as string;

      await expectCode(
        client.update(
          updateInput(id, { email: "recase@firm.example", phone: "0044 123" }),
          asBearer(operatorKey),
        ),
        Code.InvalidArgument,
      );

      // A re-cased email is the SAME natural key after normalization —
      // it must update in place, never answer ALREADY_EXISTS against
      // its own row.
      const recased = await client.update(
        updateInput(id, { email: "ReCase@Firm.example", name: "Recase" }),
        asBearer(operatorKey),
      );
      expect(recased.metadata?.id).toBe(id);
      expect(recased.spec?.email).toBe("recase@firm.example");
    });

    it("an email change re-validates uniqueness (ALREADY_EXISTS on clash) and moves the natural key", async () => {
      await client.create(userInput("taken@firm.example"), asBearer(operatorKey));
      const created = await client.create(userInput("movable@firm.example"), asBearer(operatorKey));
      const id = created.metadata?.id as string;
      const reader = asBearer(await issuer.issue("user_reader"));

      await expectCode(
        client.update(updateInput(id, { email: "taken@firm.example" }), asBearer(operatorKey)),
        Code.AlreadyExists,
        /taken@firm\.example/,
      );

      await client.update(updateInput(id, { email: "moved@firm.example" }), asBearer(operatorKey));
      expect((await client.get({ email: "moved@firm.example" }, reader)).metadata?.id).toBe(id);
      await expectCode(
        client.get({ email: "movable@firm.example" }, reader),
        Code.NotFound,
      );
    });

    it("answers NOT_FOUND for an unknown target", async () => {
      await expectCode(
        client.update(
          updateInput("user_00000000000000000000000000", { email: "ghost@firm.example" }),
          asBearer(operatorKey),
        ),
        Code.NotFound,
      );
    });
  });
});
