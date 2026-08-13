/**
 * Google service-account auth, hand-rolled (DD-009 D1): the OAuth2
 * JWT-bearer grant (RFC 7523) on node:crypto and global fetch — zero
 * new dependencies, deliberately. The backend has no HTTP client
 * (remote-fetch.ts set the precedent), the protocol is frozen, and a
 * hand-rolled exchange is unit-testable against a keypair generated
 * in-test; google-auth-library would buy nothing but a dependency.
 *
 * Failure polarity follows the provider port's three-way rule: a
 * malformed key or a non-2xx token answer is OcrConfigurationError
 * (fix the credential, never a document verdict); a network failure
 * rethrows as-is (transient — later ticks retry).
 */

import { createSign } from "node:crypto";
import { OcrConfigurationError } from "./provider.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
/** Google's maximum assertion lifetime; also the fallback when the
 * token response omits expires_in. */
const TOKEN_LIFETIME_SECONDS = 3600;
/** Refresh when within this margin of expiry, so a token handed to a
 * 15-page OCR window can never expire mid-flight. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** Backdate the assertion's iat by this much — clock-skew tolerance,
 * Google's own client libraries' practice (an assertion "issued in
 * the future" by a skewed clock is refused outright). */
const CLOCK_SKEW_SECONDS = 60;

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** An access-token source. `invalidate` drops the cached token so the
 * next call re-exchanges — the Document AI adapter calls it when a
 * request answers 401/403, so a rotated key stops being served stale
 * for up to ~55 minutes (review F8). Optional because the test seams
 * are plain functions. */
export interface TokenSource {
  (): Promise<string>;
  invalidate?: () => void;
}

/** Validates the service-account key file's shape, naming the missing
 * field; the parsed email and PEM feed the JWT assertion. */
function parseServiceAccountKey(credentialsJson: string): {
  readonly clientEmail: string;
  readonly privateKey: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(credentialsJson);
  } catch {
    throw new OcrConfigurationError(
      "OCR_DOCAI_CREDENTIALS_JSON is not valid JSON (expected a service-account key file)",
    );
  }
  const key = parsed as { client_email?: unknown; private_key?: unknown };
  if (typeof key.client_email !== "string" || key.client_email === "") {
    throw new OcrConfigurationError(
      "OCR_DOCAI_CREDENTIALS_JSON is missing client_email (expected a service-account key file)",
    );
  }
  if (typeof key.private_key !== "string" || key.private_key === "") {
    throw new OcrConfigurationError(
      "OCR_DOCAI_CREDENTIALS_JSON is missing private_key (expected a service-account key file)",
    );
  }
  return { clientEmail: key.client_email, privateKey: key.private_key };
}

/**
 * Parses the service-account key JSON and returns an access-token
 * source that caches the token, refreshes inside the expiry margin,
 * and shares one in-flight exchange among concurrent callers.
 */
export function createServiceAccountTokenSource(
  credentialsJson: string,
  fetchImpl: typeof fetch = fetch,
): TokenSource {
  const { clientEmail, privateKey } = parseServiceAccountKey(credentialsJson);

  let cached: { readonly token: string; readonly expiresAtMs: number } | undefined;
  let inflight: Promise<string> | undefined;

  async function exchange(): Promise<string> {
    // iat is backdated for clock skew; exp keeps the full lifetime
    // FROM iat, so the assertion never claims more than Google's
    // 3600-second maximum.
    const issuedAtSeconds = Math.floor(Date.now() / 1000) - CLOCK_SKEW_SECONDS;
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(
      JSON.stringify({
        iss: clientEmail,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: issuedAtSeconds,
        exp: issuedAtSeconds + TOKEN_LIFETIME_SECONDS,
      }),
    );
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    let signature: Buffer;
    try {
      signature = signer.sign(privateKey);
    } catch (err) {
      // A key that parsed as JSON but cannot SIGN (corrupt PEM, wrong
      // key type) is a configuration problem discovered at first use,
      // not a transient to retry every tick (review F9). Node's crypto
      // errors describe the decoder failure and carry no key material,
      // so the message is safe for logs (the never-log-key test).
      throw new OcrConfigurationError(
        `signing the token assertion failed (${err instanceof Error ? err.message : String(err)}) — ` +
          "check OCR_DOCAI_CREDENTIALS_JSON (private_key is not a usable RSA key)",
      );
    }
    const assertion = `${header}.${claims}.${base64url(signature)}`;

    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    if (!response.ok) {
      // Status + the server's words, and NOTHING of ours: the message
      // travels to logs, so no key material may ever ride in it
      // (asserted by test).
      throw new OcrConfigurationError(
        `token exchange answered HTTP ${response.status}: ${await response.text()} — ` +
          "check OCR_DOCAI_CREDENTIALS_JSON (service-account key)",
      );
    }
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) {
      throw new OcrConfigurationError(
        "token exchange answered 2xx without access_token — check OCR_DOCAI_CREDENTIALS_JSON",
      );
    }
    cached = {
      token: body.access_token,
      expiresAtMs: Date.now() + (body.expires_in ?? TOKEN_LIFETIME_SECONDS) * 1000,
    };
    return body.access_token;
  }

  const source: TokenSource = async () => {
    if (cached && Date.now() < cached.expiresAtMs - REFRESH_MARGIN_MS) {
      return cached.token;
    }
    if (!inflight) {
      inflight = exchange().finally(() => {
        inflight = undefined;
      });
    }
    return inflight;
  };
  source.invalidate = () => {
    cached = undefined;
  };
  return source;
}
