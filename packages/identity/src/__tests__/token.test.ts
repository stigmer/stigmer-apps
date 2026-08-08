/**
 * Token lifecycle — including the DD-005 invariant that no bearer
 * credential can escalate: verify() only ever yields user-kind
 * principals, and rejects tokens whose claims say otherwise even when
 * their signature is genuine.
 */

import { generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  generateEphemeralSigningKeys,
  loadSigningKeys,
  SIGNING_ALGORITHM,
  type SigningKeys,
} from "../keys.js";
import { createAccessTokenIssuer, TOKEN_ISSUER } from "../token.js";

function pemKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return {
    privateKeyBase64: Buffer.from(privateKey).toString("base64"),
    publicKeyBase64: Buffer.from(publicKey).toString("base64"),
  };
}

describe("access tokens", () => {
  it("round-trips: issue → verify yields the user principal", async () => {
    const issuer = createAccessTokenIssuer(await generateEphemeralSigningKeys());
    const token = await issuer.issue("user_01abc");

    expect(await issuer.verify(token)).toEqual({ id: "user_01abc", kind: "user" });
  });

  it("rejects garbage, empty strings, and tokens from a different keypair", async () => {
    const issuer = createAccessTokenIssuer(await generateEphemeralSigningKeys());
    const stranger = createAccessTokenIssuer(await generateEphemeralSigningKeys());

    expect(await issuer.verify("not-a-jwt")).toBeUndefined();
    expect(await issuer.verify("")).toBeUndefined();
    expect(await issuer.verify(await stranger.issue("user_x"))).toBeUndefined();
  });

  it("rejects expired tokens", async () => {
    const keys = await generateEphemeralSigningKeys();
    const issuer = createAccessTokenIssuer(keys);
    const expired = await new SignJWT({ token_type: "user" })
      .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: keys.kid })
      .setSubject("user_x")
      .setIssuer(TOKEN_ISSUER)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(keys.privateKey);

    expect(await issuer.verify(expired)).toBeUndefined();
  });

  it("INVARIANT: a genuinely signed token cannot claim a non-user kind", async () => {
    const keys = await generateEphemeralSigningKeys();
    const issuer = createAccessTokenIssuer(keys);
    // Forged with the REAL private key — signature verifies — but the
    // token_type claim is not "user". Operator and system kinds must be
    // unreachable through any bearer token (DD-005 invariant 1).
    for (const smuggledType of ["operator", "system", undefined]) {
      const forged = await new SignJWT(
        smuggledType ? { token_type: smuggledType } : {},
      )
        .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: keys.kid })
        .setSubject("user_x")
        .setIssuer(TOKEN_ISSUER)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey);

      expect(await issuer.verify(forged), `token_type=${smuggledType}`).toBeUndefined();
    }
  });

  it("rejects a valid signature under a foreign issuer claim", async () => {
    const keys = await generateEphemeralSigningKeys();
    const issuer = createAccessTokenIssuer(keys);
    const foreign = await new SignJWT({ token_type: "user" })
      .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: keys.kid })
      .setSubject("user_x")
      .setIssuer("someone-else")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);

    expect(await issuer.verify(foreign)).toBeUndefined();
  });

  it("loads configured PEM keys and verifies old-key tokens through the rotation window", async () => {
    const oldPair = pemKeyPair();
    const newPair = pemKeyPair();

    const oldKeys = await loadSigningKeys({ privateKeyBase64: oldPair.privateKeyBase64 });
    const rotated = await loadSigningKeys({
      privateKeyBase64: newPair.privateKeyBase64,
      previousPublicKeyBase64: oldPair.publicKeyBase64,
    });

    const oldIssuer = createAccessTokenIssuer(oldKeys);
    const rotatedIssuer = createAccessTokenIssuer(rotated);

    // A token minted before the rotation still verifies (previous public
    // key in the verification set) — and new tokens sign with the new key.
    expect(await rotatedIssuer.verify(await oldIssuer.issue("user_old"))).toEqual({
      id: "user_old",
      kind: "user",
    });
    expect(await rotatedIssuer.verify(await rotatedIssuer.issue("user_new"))).toEqual({
      id: "user_new",
      kind: "user",
    });
    // The overlap is verify-only: dropping the previous key ends it.
    const withoutOverlap = await loadSigningKeys({
      privateKeyBase64: newPair.privateKeyBase64,
    });
    const strictIssuer = createAccessTokenIssuer(withoutOverlap);
    expect(await strictIssuer.verify(await oldIssuer.issue("user_old"))).toBeUndefined();
  });

  it("rotation keeps kid stable per keypair (RFC 7638 thumbprint)", async () => {
    const pair = pemKeyPair();
    const a: SigningKeys = await loadSigningKeys({ privateKeyBase64: pair.privateKeyBase64 });
    const b: SigningKeys = await loadSigningKeys({ privateKeyBase64: pair.privateKeyBase64 });
    expect(a.kid).toBe(b.kid);
    expect(a.kid).not.toBe((await generateEphemeralSigningKeys()).kid);
  });
});
