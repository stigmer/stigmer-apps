/**
 * Signing key material for access tokens (DD-005 D4).
 *
 * RS256 with per-deployment keypairs: verifiers (the app itself today,
 * the MCP server in T05) hold only public keys, so no verifier can mint —
 * the property HS256 cannot give. The `kid` is the RFC 7638 JWK
 * thumbprint, so tokens self-identify their key; rotation keeps the
 * previous PUBLIC key in the verification set while new tokens sign with
 * the new key (the platform's StigmerJwtKeySource pattern).
 *
 * Production loads keys from configuration and fails fast when absent;
 * dev/tests generate an ephemeral pair at boot. No private key is ever
 * checked in.
 */

import { createPublicKey } from "node:crypto";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  type CryptoKey,
} from "jose";

export const SIGNING_ALGORITHM = "RS256";

export interface SigningKeys {
  /** Private key new tokens are signed with. */
  readonly privateKey: CryptoKey;
  /** `kid` of the signing key (RFC 7638 thumbprint of its public half). */
  readonly kid: string;
  /**
   * Public keys accepted for verification, by kid: always the current
   * key, plus the previous one during a rotation overlap.
   */
  readonly verificationKeys: ReadonlyMap<string, CryptoKey>;
}

export interface SigningKeyConfig {
  /** Base64-encoded PKCS#8 PEM private key (base64 makes it env-safe). */
  readonly privateKeyBase64: string;
  /**
   * Base64-encoded SPKI PEM PUBLIC key of the previous keypair, verify-only,
   * present only during a rotation overlap.
   */
  readonly previousPublicKeyBase64?: string;
}

export async function loadSigningKeys(config: SigningKeyConfig): Promise<SigningKeys> {
  const privateKeyPem = decodeBase64(config.privateKeyBase64);
  const privateKey = await importPKCS8(privateKeyPem, SIGNING_ALGORITHM);
  // Derive the public half via node:crypto rather than exporting the
  // imported private key — jose imports PKCS#8 keys non-extractable, and
  // that is worth keeping: nothing downstream can export the private key.
  const publicKeyPem = createPublicKey(privateKeyPem)
    .export({ type: "spki", format: "pem" })
    .toString();
  const publicKey = await importSPKI(publicKeyPem, SIGNING_ALGORITHM);
  const kid = await calculateJwkThumbprint(await exportJWK(publicKey));

  const verificationKeys = new Map([[kid, publicKey]]);
  if (config.previousPublicKeyBase64) {
    const previous = await importSPKI(
      decodeBase64(config.previousPublicKeyBase64),
      SIGNING_ALGORITHM,
    );
    const previousKid = await calculateJwkThumbprint(await exportJWK(previous));
    verificationKeys.set(previousKid, previous);
  }

  return { privateKey, kid, verificationKeys };
}

/** Dev/test keys: fresh pair per process, never persisted (DD-005 D4). */
export async function generateEphemeralSigningKeys(): Promise<SigningKeys> {
  const { privateKey, publicKey } = await generateKeyPair(SIGNING_ALGORITHM, {
    modulusLength: 2048,
  });
  const kid = await calculateJwkThumbprint(await exportJWK(publicKey));
  return { privateKey, kid, verificationKeys: new Map([[kid, publicKey]]) };
}

function decodeBase64(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}
