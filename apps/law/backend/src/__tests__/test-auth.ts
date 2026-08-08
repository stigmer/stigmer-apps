/**
 * Test authentication — real credentials through the REAL auth kit
 * (ephemeral signing keys, a generated operator key), replacing the
 * deleted x-dev-caller header shim. Tokens are minted asynchronously once
 * (mint(), in beforeAll) and looked up synchronously at call sites, so
 * test bodies read exactly as before: `client.create(input, asLawyer())`.
 *
 * Note the shim's one capability that deliberately has NO replacement:
 * there is no way to present a system principal from a test — or from
 * anywhere else on the wire (DD-005 invariant 1).
 */

import {
  bearerTokenAuthenticator,
  createAccessTokenIssuer,
  createCallerResolver,
  generateEphemeralSigningKeys,
  generateOperatorKey,
  operatorKeyAuthenticator,
} from "@stigmer/identity";
import type { AuthKit } from "../auth/auth.js";

export interface CallOptions {
  readonly headers: { readonly authorization: string };
}

export interface TestAuth {
  readonly kit: AuthKit;
  /** The raw operator key — needed by suites that test key handling itself. */
  readonly operatorKey: string;
  /** Mints (and caches) user access tokens for the given principal ids. */
  mint(...ids: string[]): Promise<void>;
  /** Sync call options for a principal previously minted via mint(). */
  as(id: string): CallOptions;
  asOperator(): CallOptions;
  /** An already-expired access token for the same keys — the expiry edge. */
  expiredToken(id: string): Promise<string>;
}

export async function createTestAuth(): Promise<TestAuth> {
  const operator = generateOperatorKey();
  // Composed from primitives rather than createAuthKit — same shape as
  // auth/auth.ts, but the keys stay in reach so expiredToken() can mint
  // edge-case tokens under the SAME keys the server verifies with.
  const keys = await generateEphemeralSigningKeys();
  const issuer = createAccessTokenIssuer(keys);
  const expiredIssuer = createAccessTokenIssuer(keys, { ttlSeconds: -3600 });
  const kit: AuthKit = {
    issuer,
    resolver: createCallerResolver([
      operatorKeyAuthenticator(operator.sha256Hex),
      bearerTokenAuthenticator(issuer),
    ]),
  };

  const tokens = new Map<string, string>();
  return {
    kit,
    operatorKey: operator.key,
    async mint(...ids) {
      for (const id of ids) {
        if (!tokens.has(id)) {
          tokens.set(id, await kit.issuer.issue(id));
        }
      }
    },
    as(id) {
      const token = tokens.get(id);
      if (!token) {
        throw new Error(`test-auth: no token minted for '${id}' — add it to the suite's mint() call`);
      }
      return { headers: { authorization: `Bearer ${token}` } };
    },
    asOperator: () => ({ headers: { authorization: `Bearer ${operator.key}` } }),
    expiredToken: (id) => expiredIssuer.issue(id),
  };
}
