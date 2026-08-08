#!/usr/bin/env node
/**
 * Generates a deployment's auth secrets (DD-005 D4/D7): the RS256 signing
 * keypair and the operator key. Run once per firm; paste the values into
 * the firm's config-manager artifacts under clients/<domain>/<client>/
 * (the DD-004 model). Nothing is written to disk — output goes to stdout
 * and the raw operator key exists only in this terminal.
 *
 *   node scripts/generate-auth-secrets.mjs
 *
 * Rotation: run again, move the OLD public key into
 * AUTH_JWT_PREVIOUS_PUBLIC_KEY, deploy, and drop it after the ~1h access
 * token tail has expired.
 */

import { generateKeyPairSync, createHash, randomBytes } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const operatorKey = `opk_${randomBytes(32).toString("base64url")}`;
const operatorKeySha256 = createHash("sha256").update(operatorKey).digest("hex");

console.log(`# Backend environment (config-manager variable/secret values)
AUTH_JWT_PRIVATE_KEY=${Buffer.from(privateKey).toString("base64")}
AUTH_OPERATOR_KEY_SHA256=${operatorKeySha256}

# Keep for the NEXT rotation (goes into AUTH_JWT_PREVIOUS_PUBLIC_KEY then):
# public key (base64 SPKI PEM)
${Buffer.from(publicKey).toString("base64")}

# THE OPERATOR KEY — shown once, never stored server-side (the backend
# holds only the hash above). Keep it with the operator:
${operatorKey}`);
