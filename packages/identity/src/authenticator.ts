/**
 * The authenticator chain — the seam DD-005 D1 exists to own.
 *
 * Each authenticator inspects a presented bearer credential and either
 * claims it (returns a principal), or passes (returns undefined). First
 * claim wins; an exhausted chain means unauthenticated. This is the Java
 * parent's ProviderManager shape (api-authentication's four-provider
 * chain) minus the framework weight.
 *
 * Growth path, by design: an OIDC authenticator ("bring your own IdP"),
 * an API-key authenticator, and T05's channel authenticator (MCP service
 * credential + wa_id binding) each drop in as one more element in the
 * app's declared chain — no app code changes. None is built until it has
 * a real consumer (DD-005 D1's scope guard).
 */

import type { CallerPrincipal } from "@stigmer/resource-api";
import { OPERATOR_KEY_PREFIX, OPERATOR_PRINCIPAL, verifyOperatorKey } from "./operator-key.js";
import type { AccessTokenIssuer } from "./token.js";

export interface Authenticator {
  /** For logs and chain-composition errors. */
  readonly name: string;
  /**
   * Returns the verified principal, or undefined when the credential is
   * not this authenticator's kind OR fails its verification — both mean
   * "not authenticated by me", and an unauthenticated caller already
   * answers UNAUTHENTICATED at the authorize step.
   */
  authenticate(credential: string): Promise<CallerPrincipal | undefined>;
}

/** Locally-signed access tokens (the JWTs Login mints). */
export function bearerTokenAuthenticator(issuer: AccessTokenIssuer): Authenticator {
  return {
    name: "bearer-token",
    authenticate: (credential) => issuer.verify(credential),
  };
}

/** The per-deployment operator key (DD-005 D7). */
export function operatorKeyAuthenticator(operatorKeySha256Hex: string): Authenticator {
  return {
    name: "operator-key",
    async authenticate(credential) {
      if (!credential.startsWith(OPERATOR_KEY_PREFIX)) {
        return undefined;
      }
      return verifyOperatorKey(credential, operatorKeySha256Hex)
        ? OPERATOR_PRINCIPAL
        : undefined;
    },
  };
}

/** First claim wins, in declared order. */
export function composeAuthenticators(
  authenticators: readonly Authenticator[],
): (credential: string) => Promise<CallerPrincipal | undefined> {
  if (authenticators.length === 0) {
    throw new Error("composeAuthenticators: at least one authenticator is required");
  }
  return async (credential) => {
    for (const authenticator of authenticators) {
      const principal = await authenticator.authenticate(credential);
      if (principal) {
        return principal;
      }
    }
    return undefined;
  };
}
