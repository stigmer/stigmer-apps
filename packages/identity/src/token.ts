/**
 * Access-token issue/verify — locally signed JWTs, the "smallest correct
 * issuer" of DD-005 D1.
 *
 * Claim discipline (the tested invariant): this issuer mints USER tokens
 * only. `token_type: "user"` is asserted on verify, so no bearer
 * credential can ever produce an operator or system principal — those
 * kinds come exclusively from the operator-key authenticator and from
 * in-process invocation respectively.
 */

import { jwtVerify, SignJWT } from "jose";
import type { CallerPrincipal } from "@stigmer/resource-api";
import { SIGNING_ALGORITHM, type SigningKeys } from "./keys.js";

/**
 * Issuer claim: the identity commons, not a product brand (DD-A2 — the
 * wire carries capability names). Per-deployment keys carry the
 * firm-isolation guarantee; `iss` guards against cross-SYSTEM confusion.
 */
export const TOKEN_ISSUER = "stigmer-identity";

const TOKEN_TYPE_CLAIM = "token_type";
const USER_TOKEN_TYPE = "user";

/** T01 owner decision 1: access ~1h. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

export interface AccessTokenIssuer {
  issue(userId: string): Promise<string>;
  /**
   * Returns the verified principal, or undefined for anything invalid
   * (bad signature, wrong issuer, expired, wrong token_type). Invalid
   * simply means unauthenticated — the authorize step supplies the
   * client-facing UNAUTHENTICATED answer.
   */
  verify(token: string): Promise<CallerPrincipal | undefined>;
}

export function createAccessTokenIssuer(
  keys: SigningKeys,
  options: { ttlSeconds?: number } = {},
): AccessTokenIssuer {
  const ttlSeconds = options.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS;

  return {
    async issue(userId) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      return new SignJWT({ [TOKEN_TYPE_CLAIM]: USER_TOKEN_TYPE })
        .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: keys.kid })
        .setSubject(userId)
        .setIssuer(TOKEN_ISSUER)
        .setIssuedAt(nowSeconds)
        // Numeric exp (not a "1h" timespan string): unambiguous for any
        // ttl sign — tests mint already-expired tokens with a negative ttl.
        .setExpirationTime(nowSeconds + ttlSeconds)
        .sign(keys.privateKey);
    },

    async verify(token) {
      try {
        const { payload } = await jwtVerify(
          token,
          (header) => {
            const key = header.kid ? keys.verificationKeys.get(header.kid) : undefined;
            if (!key) {
              throw new Error(`unknown signing key '${header.kid ?? "(no kid)"}'`);
            }
            return key;
          },
          // Pinning the algorithm list forecloses algorithm-confusion
          // attacks (e.g. an HS256 token "signed" with the public key).
          { issuer: TOKEN_ISSUER, algorithms: [SIGNING_ALGORITHM] },
        );
        if (payload[TOKEN_TYPE_CLAIM] !== USER_TOKEN_TYPE || !payload.sub) {
          return undefined;
        }
        return { id: payload.sub, kind: "user" };
      } catch {
        // Verification failures are routine (expired sessions above all)
        // and carry no signal worth logging per-request.
        return undefined;
      }
    },
  };
}
