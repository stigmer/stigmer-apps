import { describe, expect, it } from "vitest";
import {
  bearerTokenAuthenticator,
  composeAuthenticators,
  operatorKeyAuthenticator,
  type Authenticator,
} from "../authenticator.js";
import { generateEphemeralSigningKeys } from "../keys.js";
import { generateOperatorKey, OPERATOR_PRINCIPAL } from "../operator-key.js";
import { createAccessTokenIssuer } from "../token.js";

describe("operatorKeyAuthenticator", () => {
  it("authenticates the configured key as the operator principal", async () => {
    const { key, sha256Hex } = generateOperatorKey();
    const auth = operatorKeyAuthenticator(sha256Hex);

    expect(await auth.authenticate(key)).toEqual(OPERATOR_PRINCIPAL);
  });

  it("passes on non-opk credentials and rejects wrong keys", async () => {
    const { sha256Hex } = generateOperatorKey();
    const auth = operatorKeyAuthenticator(sha256Hex);

    expect(await auth.authenticate("eyJhbGciOi.something.else")).toBeUndefined();
    expect(await auth.authenticate(generateOperatorKey().key)).toBeUndefined();
    expect(await auth.authenticate("opk_")).toBeUndefined();
  });
});

describe("composeAuthenticators", () => {
  it("first claim wins, later authenticators are not consulted", async () => {
    const calls: string[] = [];
    const make = (name: string, claims: boolean): Authenticator => ({
      name,
      async authenticate() {
        calls.push(name);
        return claims ? { id: name, kind: "user" } : undefined;
      },
    });

    const chain = composeAuthenticators([make("first", false), make("second", true), make("third", true)]);
    const principal = await chain("anything");

    expect(principal?.id).toBe("second");
    expect(calls).toEqual(["first", "second"]);
  });

  it("an exhausted chain is unauthenticated, and an empty chain is a construction error", async () => {
    const chain = composeAuthenticators([operatorKeyAuthenticator(generateOperatorKey().sha256Hex)]);
    expect(await chain("rft_not-an-access-credential")).toBeUndefined();
    expect(() => composeAuthenticators([])).toThrowError(/at least one/);
  });

  it("the production shape: operator key and bearer token coexist, kinds cannot cross", async () => {
    const keys = await generateEphemeralSigningKeys();
    const issuer = createAccessTokenIssuer(keys);
    const { key: operatorKey, sha256Hex } = generateOperatorKey();
    const chain = composeAuthenticators([
      operatorKeyAuthenticator(sha256Hex),
      bearerTokenAuthenticator(issuer),
    ]);

    expect(await chain(operatorKey)).toEqual(OPERATOR_PRINCIPAL);
    expect(await chain(await issuer.issue("user_1"))).toEqual({ id: "user_1", kind: "user" });
    // DD-005 invariant 1, chain-level: no credential yields kind system.
    expect((await chain(operatorKey))?.kind).not.toBe("system");
    expect((await chain(await issuer.issue("system")))?.kind).toBe("user");
  });
});
