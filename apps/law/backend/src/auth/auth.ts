/**
 * The app's authentication composition — config in, working auth out.
 * This file replaces the T02 `x-dev-caller-*` shim (auth/caller.ts,
 * deleted at T04a): identity now comes from @stigmer/identity's
 * authenticator chain, and BOTH transports (Connect handlers and the
 * plain-HTTP byte routes) resolve callers through the one resolver built
 * here.
 *
 * Extraction seam: vertical #2 will want this composition verbatim; it
 * stays app-owned until that consumer exists (the no-premature-extraction
 * rule), because the config shape it reads is the app's.
 */

import {
  bearerTokenAuthenticator,
  createAccessTokenIssuer,
  createCallerResolver,
  generateEphemeralSigningKeys,
  loadSigningKeys,
  operatorKeyAuthenticator,
  type AccessTokenIssuer,
  type CallerResolver,
} from "@stigmer/identity";
import type { AuthConfig } from "../config.js";

export interface AuthKit {
  /** Mints and verifies access tokens (Login's issuer, the chain's verifier). */
  readonly issuer: AccessTokenIssuer;
  /** The one caller seam for every transport entrance. */
  readonly resolver: CallerResolver;
}

export async function createAuthKit(config: AuthConfig): Promise<AuthKit> {
  const keys = config.ephemeralKeys
    ? // Dev/tests only (config.ts refuses this alongside configured
      // keys): a fresh pair per process, tokens die with it.
      await generateEphemeralSigningKeys()
    : await loadSigningKeys({
        privateKeyBase64: config.privateKeyBase64 as string,
        previousPublicKeyBase64: config.previousPublicKeyBase64,
      });

  const issuer = createAccessTokenIssuer(keys);
  return {
    issuer,
    // Operator key first: its prefix peek is O(1), and bearer JWTs can
    // never look like `opk_…` — order is routing, not privilege.
    resolver: createCallerResolver([
      operatorKeyAuthenticator(config.operatorKeySha256Hex),
      bearerTokenAuthenticator(issuer),
    ]),
  };
}
