/**
 * The Document AI adapter, proven against a fetch fake: the REQUEST
 * shape carries the two documented traps (imagelessMode at TOP level;
 * per-page text anchored into document.text), one page window per
 * call (the SWEEP owns chunking — review F6; the adapter asserts the
 * ceiling), and byte-offset anchor slicing is what keeps non-ASCII
 * scripts intact (protobuf offsets index UTF-8, not UTF-16).
 * Classification follows the port's three-way rule by HTTP status,
 * message-aware on 400 (review F3).
 *
 * Fixtures are fictional by construction — invented ids, invented
 * strings (the Telugu fixture is invented text, not a document).
 */

import { describe, expect, it } from "vitest";
import type { TokenSource } from "../google-auth.js";
import { createDocumentAiProvider, sliceAnchoredText, WINDOW_PAGES } from "../document-ai.js";
import { OcrBytesRejectedError, OcrConfigurationError } from "../provider.js";

const PROCESSOR = "projects/000000/locations/asia-south1/processors/feedcafe";
const BYTES = new TextEncoder().encode("fictional scan bytes");

interface CapturedCall {
  readonly url: string;
  readonly authorization: string;
  readonly contentType: string;
  readonly body: {
    readonly rawDocument?: { content?: string; mimeType?: string };
    readonly imagelessMode?: boolean;
    readonly processOptions?: {
      readonly imagelessMode?: boolean;
      readonly individualPageSelector?: { pages?: number[] };
    };
    readonly fieldMask?: string;
  };
}

interface FakePage {
  readonly pageNumber?: number;
  readonly detectedLanguages?: { languageCode?: string; confidence?: number }[];
  readonly textSegments?: { startIndex?: string | number; endIndex?: string | number }[];
}

function processResponse(text: string, pages: FakePage[]): Response {
  return new Response(
    JSON.stringify({
      document: {
        text,
        pages: pages.map((page) => ({
          pageNumber: page.pageNumber,
          detectedLanguages: page.detectedLanguages,
          layout: { textAnchor: { textSegments: page.textSegments ?? [] } },
        })),
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Captures every call; answers via the handler (defaults to echoing
 * each requested page back with empty anchors). */
function fakeProcessEndpoint(
  handler?: (call: CapturedCall, index: number) => Response,
): { impl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const impl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const call: CapturedCall = {
      url: String(input),
      authorization: headers.get("authorization") ?? "",
      contentType: headers.get("content-type") ?? "",
      body: JSON.parse(String(init?.body ?? "{}")) as CapturedCall["body"],
    };
    calls.push(call);
    if (handler) return handler(call, calls.length - 1);
    const pages = call.body.processOptions?.individualPageSelector?.pages ?? [];
    return processResponse("", pages.map((pageNumber) => ({ pageNumber })));
  };
  return { impl, calls };
}

function provider(fake: { impl: typeof fetch }, overrides?: { endpointBaseUrl?: string }) {
  return createDocumentAiProvider({
    processor: PROCESSOR,
    tokenSource: async () => "tok-test",
    fetchImpl: fake.impl,
    ...overrides,
  });
}

describe("createDocumentAiProvider — construction", () => {
  it("refuses zero and two token authorities alike", () => {
    expect(() => createDocumentAiProvider({ processor: PROCESSOR })).toThrowError(
      OcrConfigurationError,
    );
    expect(() =>
      createDocumentAiProvider({
        processor: PROCESSOR,
        credentialsJson: "{}",
        tokenSource: async () => "tok",
      }),
    ).toThrowError(OcrConfigurationError);
  });

  it("derives the regional endpoint from the processor name, and refuses a name without one", async () => {
    const fake = fakeProcessEndpoint();
    await provider(fake).recognize(BYTES, "application/pdf", [1]);
    expect(fake.calls[0]!.url).toBe(
      `https://asia-south1-documentai.googleapis.com/v1/${PROCESSOR}:process`,
    );

    expect(() =>
      createDocumentAiProvider({
        processor: "processors/no-location-here",
        tokenSource: async () => "tok",
      }),
    ).toThrowError(OcrConfigurationError);
  });

  it("honors an endpointBaseUrl override (the fake-server seam)", async () => {
    const fake = fakeProcessEndpoint();
    await provider(fake, { endpointBaseUrl: "http://127.0.0.1:4444" }).recognize(
      BYTES,
      "image/png",
      [1],
    );
    expect(fake.calls[0]!.url).toBe(`http://127.0.0.1:4444/v1/${PROCESSOR}:process`);
  });
});

describe("createDocumentAiProvider — request shape", () => {
  it("sends imagelessMode at the TOP level, the page selector, the fieldMask, and the bearer header", async () => {
    const fake = fakeProcessEndpoint();
    await provider(fake).recognize(BYTES, "application/pdf", [1, 2, 3]);

    const call = fake.calls[0]!;
    expect(call.authorization).toBe("Bearer tok-test");
    expect(call.contentType).toBe("application/json");
    expect(call.body.imagelessMode).toBe(true);
    // The documented failure mode: nested imagelessMode is silently
    // ignored — assert it is NOT where it would be ignored.
    expect(call.body.processOptions?.imagelessMode).toBeUndefined();
    expect(call.body.processOptions?.individualPageSelector?.pages).toEqual([1, 2, 3]);
    expect(call.body.fieldMask).toBe("text,pages.pageNumber,pages.detectedLanguages,pages.layout");
    expect(call.body.rawDocument?.content).toBe(Buffer.from(BYTES).toString("base64"));
    expect(call.body.rawDocument?.mimeType).toBe("application/pdf");
  });
});

describe("createDocumentAiProvider — the single-window contract (review F6)", () => {
  it("advertises maxPagesPerCall 15 (the sync-limit window)", () => {
    const fake = fakeProcessEndpoint();
    expect(WINDOW_PAGES).toBe(15);
    expect(provider(fake).maxPagesPerCall).toBe(15);
  });

  it("accepts a full 15-page window as ONE request, and refuses 16 without calling out", async () => {
    const fake = fakeProcessEndpoint();
    const full = Array.from({ length: 15 }, (_, i) => i + 1);
    const result = await provider(fake).recognize(BYTES, "application/pdf", full);
    expect(fake.calls).toHaveLength(1);
    expect(result.map((page) => page.page)).toEqual(full);

    // 16 pages is a caller bug (the sweep owns chunking) — a plain
    // Error, never a typed provider verdict, and NO network call.
    const failure = await provider(fake)
      .recognize(BYTES, "application/pdf", Array.from({ length: 16 }, (_, i) => i + 1))
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(OcrBytesRejectedError);
    expect(failure).not.toBeInstanceOf(OcrConfigurationError);
    expect((failure as Error).message).toContain("maxPagesPerCall");
    expect(fake.calls).toHaveLength(1);
  });
});

describe("createDocumentAiProvider — response mapping", () => {
  it("slices each page's text from document.text through its anchors, including an omitted startIndex", async () => {
    const text = "first page words second page words";
    const fake = fakeProcessEndpoint(() =>
      processResponse(text, [
        // startIndex omitted — proto3 JSON drops the zero.
        { pageNumber: 1, textSegments: [{ endIndex: "17" }] },
        { pageNumber: 2, textSegments: [{ startIndex: "17", endIndex: String(text.length) }] },
      ]),
    );
    const result = await provider(fake).recognize(BYTES, "application/pdf", [1, 2]);

    expect(result).toEqual([
      { page: 1, text: "first page words ", language: "", confidence: 0 },
      { page: 2, text: "second page words", language: "", confidence: 0 },
    ]);
  });

  it("concatenates multi-segment anchors in order", async () => {
    const fake = fakeProcessEndpoint(() =>
      processResponse("abcdefghij", [
        { pageNumber: 1, textSegments: [{ endIndex: "3" }, { startIndex: "5", endIndex: "7" }] },
      ]),
    );
    const result = await provider(fake).recognize(BYTES, "application/pdf", [1]);
    expect(result[0]!.text).toBe("abcfg");
  });

  it("picks the highest-confidence detected language; absent languages map to empty/zero", async () => {
    const fake = fakeProcessEndpoint(() =>
      processResponse("x", [
        {
          pageNumber: 1,
          textSegments: [{ endIndex: "1" }],
          detectedLanguages: [
            { languageCode: "en", confidence: 0.2 },
            { languageCode: "te", confidence: 0.7 },
            { languageCode: "hi", confidence: 0.1 },
          ],
        },
        { pageNumber: 2, textSegments: [] },
      ]),
    );
    const result = await provider(fake).recognize(BYTES, "application/pdf", [1, 2]);

    expect(result[0]!.language).toBe("te");
    expect(result[0]!.confidence).toBeCloseTo(0.7);
    expect(result[1]!.language).toBe("");
    expect(result[1]!.confidence).toBe(0);
  });
});

describe("sliceAnchoredText", () => {
  // The signature takes the PRE-ENCODED bytes: mapDocument encodes
  // document.text once per response, not once per page (review F10).
  const utf8 = (text: string) => Buffer.from(text, "utf8");

  it("slices by UTF-8 BYTE offsets, returning intact non-ASCII graphemes", () => {
    // Invented Telugu text (fictional by construction): "sample page
    // text" / "second part". Telugu characters are 3 UTF-8 bytes each,
    // so code-unit slicing at these offsets would shear characters.
    const first = "నమూనా పేజీ పాఠ్యం";
    const second = "రెండవ భాగం";
    const text = `${first}${second}`;
    const firstBytes = Buffer.byteLength(first, "utf8");
    expect(firstBytes).toBeGreaterThan(first.length); // the trap being tested

    expect(sliceAnchoredText(utf8(text), [{ endIndex: String(firstBytes) }])).toBe(first);
    expect(
      sliceAnchoredText(utf8(text), [
        { startIndex: String(firstBytes), endIndex: String(Buffer.byteLength(text, "utf8")) },
      ]),
    ).toBe(second);
  });

  it("accepts numeric offsets, treats omitted indices as zero, and answers empty for no segments", () => {
    expect(sliceAnchoredText(utf8("abcdef"), [{ startIndex: 2, endIndex: 4 }])).toBe("cd");
    // Both omitted → the empty [0, 0) slice, not the whole text.
    expect(sliceAnchoredText(utf8("abcdef"), [{}])).toBe("");
    expect(sliceAnchoredText(utf8("abcdef"), [])).toBe("");
  });

  it("throws a plain Error naming the offending index on a non-safe-integer offset (review F11)", () => {
    // A corrupted int64 string past 2^53 would silently lose
    // precision through Number(); the guard makes it loud instead.
    const huge = "9007199254740993"; // 2^53 + 1
    expect(() => sliceAnchoredText(utf8("abcdef"), [{ startIndex: "0", endIndex: huge }])).toThrow(
      /endIndex=9007199254740993/,
    );
    expect(() =>
      sliceAnchoredText(utf8("abcdef"), [{ startIndex: "not-a-number", endIndex: "4" }]),
    ).toThrow(/startIndex=not-a-number/);
  });
});

describe("createDocumentAiProvider — error classification", () => {
  function failingProvider(status: number, body: string) {
    const fake = fakeProcessEndpoint(() => new Response(body, { status }));
    return provider(fake);
  }

  it.each([
    "Unsupported input file format.",
    "INVALID IMAGE CONTENT detected", // case-insensitive matching
    "The document appears to be corrupt.",
    "Document is password protected.",
    "The PDF is encrypted.",
  ])(
    "classifies 400 '%s' as OcrBytesRejectedError — a recognized verdict about the bytes",
    async (message) => {
      const failure = await failingProvider(400, JSON.stringify({ error: { message } }))
        .recognize(BYTES, "application/pdf", [1])
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(OcrBytesRejectedError);
      expect((failure as Error).message).toContain(message);
    },
  );

  it("classifies a 400 with an UNRECOGNIZED message as configuration, never a document verdict (review F3)", async () => {
    // Our own request-shape bugs also answer 400 (the session-14
    // principle) — e.g. a malformed fieldMask or selector.
    const failure = await failingProvider(
      400,
      JSON.stringify({ error: { message: "Invalid field mask path: pages.bogus" } }),
    )
      .recognize(BYTES, "application/pdf", [1])
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(OcrConfigurationError);
    expect(failure).not.toBeInstanceOf(OcrBytesRejectedError);
    expect((failure as Error).message).toContain("Invalid field mask path");
  });

  it("classifies 413 as configuration — payload sizing is the adapter's problem, not the document's", async () => {
    const failure = await failingProvider(413, "payload too large")
      .recognize(BYTES, "application/pdf", [1])
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(OcrConfigurationError);
    expect(failure).not.toBeInstanceOf(OcrBytesRejectedError);
    expect((failure as Error).message).toContain("413");
  });

  it("classifies 401/403 as OcrConfigurationError naming the credentials variable", async () => {
    for (const status of [401, 403]) {
      const failure = await failingProvider(status, "denied")
        .recognize(BYTES, "application/pdf", [1])
        .catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(OcrConfigurationError);
      expect((failure as Error).message).toContain("OCR_DOCAI_CREDENTIALS_JSON");
    }
  });

  it("classifies 404 as OcrConfigurationError naming the processor variable", async () => {
    const failure = await failingProvider(404, "no such processor")
      .recognize(BYTES, "application/pdf", [1])
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(OcrConfigurationError);
    expect((failure as Error).message).toContain("OCR_DOCAI_PROCESSOR");
  });

  it("classifies 429 and 5xx as plain transient Errors, never the typed verdicts", async () => {
    for (const status of [429, 500, 503]) {
      const failure = await failingProvider(status, "try later")
        .recognize(BYTES, "application/pdf", [1])
        .catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(OcrBytesRejectedError);
      expect(failure).not.toBeInstanceOf(OcrConfigurationError);
      expect((failure as Error).message).toContain(String(status));
    }
  });

  it("rethrows fetch rejections as-is (transient by the port's rule)", async () => {
    const impl: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const failure = await provider({ impl })
      .recognize(BYTES, "application/pdf", [1])
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(TypeError);
  });

  it("invalidates the cached token on 401 — the next recognize() performs a fresh exchange (review F8)", async () => {
    // A caching token source shaped like the real one: exchanges are
    // counted, and only invalidate() clears the cache.
    let exchanges = 0;
    let cachedToken: string | undefined;
    const tokenSource: TokenSource = async () => {
      if (cachedToken === undefined) {
        exchanges += 1;
        cachedToken = `tok-${exchanges}`;
      }
      return cachedToken;
    };
    tokenSource.invalidate = () => {
      cachedToken = undefined;
    };

    let call = 0;
    const fake = fakeProcessEndpoint((request) => {
      call += 1;
      return call === 1
        ? new Response("expired token", { status: 401 })
        : processResponse(
            "",
            (request.body.processOptions?.individualPageSelector?.pages ?? []).map(
              (pageNumber) => ({ pageNumber }),
            ),
          );
    });
    const p = createDocumentAiProvider({
      processor: PROCESSOR,
      tokenSource,
      fetchImpl: fake.impl,
    });

    const failure = await p.recognize(BYTES, "application/pdf", [1]).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(OcrConfigurationError);

    // The stale token was dropped BEFORE classification: this call
    // exchanges anew instead of serving tok-1 for another ~55 minutes.
    await p.recognize(BYTES, "application/pdf", [1]);
    expect(exchanges).toBe(2);
    expect(fake.calls[1]!.authorization).toBe("Bearer tok-2");
  });
});
