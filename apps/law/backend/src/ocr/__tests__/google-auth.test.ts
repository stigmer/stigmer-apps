/**
 * The hand-rolled JWT-bearer exchange (DD-009 D1), proven against a
 * real RSA keypair generated in-test: the assertion must VERIFY, not
 * just decode — a wrong signing input would still produce three
 * base64url parts. Caching, refresh, and the in-flight share are the
 * cost guard's foundation (every needless exchange is latency on a
 * billed call); the no-key-material-in-errors assertion is the
 * security floor for a message that travels to logs.
 *
 * Fixtures are fictional by construction: the keypair is generated
 * here, the account email is invented.
 */

import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServiceAccountTokenSource } from "../google-auth.js";
import { OcrConfigurationError } from "../provider.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CLIENT_EMAIL = "law-ocr-robot@fictional-project.iam.gserviceaccount.com";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const CREDENTIALS_JSON = JSON.stringify({
  client_email: CLIENT_EMAIL,
  private_key: privateKey,
});

interface Captured {
  readonly url: string;
  readonly method: string;
  readonly contentType: string;
  readonly form: URLSearchParams;
}

/** A fetch fake answering from a response queue; the last response
 * repeats when the queue drains. */
function fakeTokenEndpoint(responses: (() => Response)[]): {
  impl: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      contentType: new Headers(init?.headers).get("content-type") ?? "",
      form: new URLSearchParams(String(init?.body ?? "")),
    });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (!next) throw new Error("test bug: no response configured");
    return next();
  };
  return { impl, calls };
}

function tokenResponse(token: string, expiresIn = 3600): () => Response {
  return () =>
    new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

function decodeJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createServiceAccountTokenSource", () => {
  it("posts a JWT-bearer grant whose header, claims, and signature verify against the public key", async () => {
    const { impl, calls } = fakeTokenEndpoint([tokenResponse("tok-1")]);
    const source = createServiceAccountTokenSource(CREDENTIALS_JSON, impl);

    const token = await source();

    expect(token).toBe("tok-1");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(TOKEN_URL);
    expect(call.method).toBe("POST");
    expect(call.contentType).toBe("application/x-www-form-urlencoded");
    expect(call.form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");

    const assertion = call.form.get("assertion") ?? "";
    const [header, claims, signature] = assertion.split(".");
    expect(header && claims && signature).toBeTruthy();
    expect(decodeJson(header!)).toEqual({ alg: "RS256", typ: "JWT" });
    const decoded = decodeJson(claims!);
    expect(decoded.iss).toBe(CLIENT_EMAIL);
    expect(decoded.scope).toBe("https://www.googleapis.com/auth/cloud-platform");
    expect(decoded.aud).toBe(TOKEN_URL);
    expect(typeof decoded.iat).toBe("number");
    // iat is backdated 60s for clock-skew tolerance (Google's own
    // libraries' practice — review F12); exp keeps the full lifetime
    // FROM iat so the assertion never exceeds the 3600s maximum.
    expect(decoded.iat as number).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) - 60);
    expect(decoded.exp).toBe((decoded.iat as number) + 3600);

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    expect(verifier.verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
  });

  it("caches the token — two sequential calls make one exchange", async () => {
    const { impl, calls } = fakeTokenEndpoint([tokenResponse("tok-1")]);
    const source = createServiceAccountTokenSource(CREDENTIALS_JSON, impl);

    expect(await source()).toBe("tok-1");
    expect(await source()).toBe("tok-1");
    expect(calls).toHaveLength(1);
  });

  it("shares one in-flight exchange among concurrent callers", async () => {
    const { impl, calls } = fakeTokenEndpoint([tokenResponse("tok-1")]);
    const source = createServiceAccountTokenSource(CREDENTIALS_JSON, impl);

    const [a, b] = await Promise.all([source(), source()]);

    expect(a).toBe("tok-1");
    expect(b).toBe("tok-1");
    expect(calls).toHaveLength(1);
  });

  it("invalidate() drops the cached token — the next call re-exchanges (review F8)", async () => {
    const { impl, calls } = fakeTokenEndpoint([tokenResponse("tok-1"), tokenResponse("tok-2")]);
    const source = createServiceAccountTokenSource(CREDENTIALS_JSON, impl);

    expect(await source()).toBe("tok-1");
    // Without invalidation the cache would hold tok-1 for ~55 more
    // minutes — exactly the stale-after-rotation window F8 closes.
    source.invalidate?.();
    expect(await source()).toBe("tok-2");
    expect(calls).toHaveLength(2);
  });

  it("refreshes when inside five minutes of expiry, not before", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T06:00:00Z"));
    const { impl, calls } = fakeTokenEndpoint([tokenResponse("tok-1"), tokenResponse("tok-2")]);
    const source = createServiceAccountTokenSource(CREDENTIALS_JSON, impl);

    expect(await source()).toBe("tok-1");

    // One millisecond before the margin: still cached.
    vi.setSystemTime(new Date("2026-08-13T06:00:00Z").getTime() + 3300_000 - 1);
    expect(await source()).toBe("tok-1");
    expect(calls).toHaveLength(1);

    // At the margin (expiry 3600s minus the 5-minute margin): refresh.
    vi.setSystemTime(new Date("2026-08-13T06:00:00Z").getTime() + 3300_000);
    expect(await source()).toBe("tok-2");
    expect(calls).toHaveLength(2);
  });

  it("answers a non-2xx exchange with OcrConfigurationError naming the status — and never the key", async () => {
    const { impl } = fakeTokenEndpoint([
      () => new Response("invalid_grant: fictional refusal", { status: 400 }),
    ]);
    const source = createServiceAccountTokenSource(CREDENTIALS_JSON, impl);

    const failure = await source().catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(OcrConfigurationError);
    const message = (failure as Error).message;
    expect(message).toContain("400");
    expect(message).toContain("invalid_grant: fictional refusal");
    // The private key must never ride into a log line: assert against
    // a distinctive slice of the PEM body, not just the whole string.
    const keyBodyLine = privateKey.split("\n")[1]!;
    expect(keyBodyLine.length).toBeGreaterThan(20);
    expect(message).not.toContain(keyBodyLine);
    expect(message).not.toContain("PRIVATE KEY");
  });

  it("rethrows a network failure as-is (transient, never a config verdict) and retries on the next call", async () => {
    let attempts = 0;
    const impl: typeof fetch = async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed");
      return tokenResponse("tok-after-outage")();
    };
    const source = createServiceAccountTokenSource(CREDENTIALS_JSON, impl);

    const failure = await source().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).not.toBeInstanceOf(OcrConfigurationError);

    // The failed in-flight exchange must not wedge the source.
    expect(await source()).toBe("tok-after-outage");
  });

  it("refuses malformed credentials JSON at construction", () => {
    expect(() => createServiceAccountTokenSource("not json at all")).toThrowError(
      OcrConfigurationError,
    );
  });

  it("answers a corrupt PEM in a structurally valid key with OcrConfigurationError at first use (review F9)", async () => {
    // JSON parses, both fields present — construction succeeds; the
    // sign call is where the rot surfaces, and it must be a config
    // verdict (fix the credential), not a transient retried each tick.
    const corrupt = JSON.stringify({
      client_email: CLIENT_EMAIL,
      private_key: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key-body\n-----END PRIVATE KEY-----\n",
    });
    const { impl, calls } = fakeTokenEndpoint([tokenResponse("never-reached")]);
    const source = createServiceAccountTokenSource(corrupt, impl);

    const failure = await source().catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(OcrConfigurationError);
    const message = (failure as Error).message;
    expect(message).toContain("OCR_DOCAI_CREDENTIALS_JSON");
    // Crypto errors carry no key material — the never-log-key floor.
    expect(message).not.toContain("not-a-real-key-body");
    // The exchange never left the process: signing failed first.
    expect(calls).toHaveLength(0);
  });

  it("refuses a key file missing client_email or private_key, naming the field", () => {
    expect(() =>
      createServiceAccountTokenSource(JSON.stringify({ private_key: privateKey })),
    ).toThrowError(/client_email/);
    expect(() =>
      createServiceAccountTokenSource(JSON.stringify({ client_email: CLIENT_EMAIL })),
    ).toThrowError(/private_key/);
  });
});
