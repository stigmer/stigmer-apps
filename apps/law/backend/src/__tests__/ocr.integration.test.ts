/**
 * The OCR sweep, end to end against a FAKE Document AI (DD-009): the
 * real adapter (createDocumentAiProvider) pointed at a local node:http
 * server through its endpoint/token seams, the real upload route
 * against real MinIO, the real extraction sweep classifying
 * NO_TEXT_LAYER, and the real OCR sweep writing through the full
 * DocumentPage pipeline as the system principal.
 *
 * The fake records EVERY request body, so the tests assert the wire
 * contract Google actually enforces (imagelessMode TOP-LEVEL, inline
 * rawDocument, individualPageSelector windows) and the sweep's billing
 * discipline (idempotency, resume-from-partial, backoff, the page
 * budget) by counting provider requests — the unit that costs money.
 *
 * Failure polarity under test is the provider port's three-way rule:
 * 400 with a recognized bytes verdict → terminal OCR_FAILED; any other
 * 400 and 401/403/404/413 → configuration, NO document verdict
 * (session-14); 429/5xx → transient, backed off per document.
 *
 * All fixture text is INVENTED (fictional matters, invented Telugu
 * strings — DD-A10); nothing here ever came from a real customer.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InProcessEventDispatcher, SYSTEM_PRINCIPAL } from "@stigmer/resource-api";
import { runMigrations } from "@stigmer/resource-api/postgres";
import {
  createCallerIdentityResolver,
  UserSchema,
  UserService,
  type CallerIdentity,
} from "@stigmer/identity";
import {
  createPgActivationCodeStore,
  createPgCredentialStore,
  createPgRefreshTokenStore,
} from "@stigmer/identity/postgres";
import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthorizationEngine } from "@stigmer/authorization";
import {
  CaseSchema,
  CaseService,
  ClientRole,
  ForumKind,
} from "../gen/stigmer/law/case/v1/case_pb.js";
import { ClientSchema, ClientService } from "../gen/stigmer/law/client/v1/client_pb.js";
import {
  type Document,
  ExtractionState,
  GetDocumentRequestSchema,
} from "../gen/stigmer/law/document/v1/document_pb.js";
import {
  type DocumentPage,
  DocumentPageSchema,
  ListDocumentPagesRequestSchema,
  TextSource,
} from "../gen/stigmer/law/documentpage/v1/documentpage_pb.js";
import {
  FirmMemberSchema,
  FirmMemberService,
  FirmRole,
} from "../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import {
  runExtractionSweepOnce,
  type ExtractionSweepDeps,
} from "../domain/document/extraction-sweep.js";
import {
  createOcrBackoff,
  runOcrSweepOnce,
  type OcrBackoff,
} from "../domain/document/ocr-sweep.js";
import { storeCaseDocument } from "../domain/document/store-document.js";
import { fetchRemoteDocument } from "../files/remote-fetch.js";
import { createDocumentAiProvider } from "../ocr/document-ai.js";
import type { OcrProvider } from "../ocr/provider.js";
import { FIRM_TOOL_REGISTRARS } from "../mcp/server.js";
import type { ToolDeps } from "../mcp/tools/shared.js";
import { createS3ObjectStore, type ObjectStore } from "../objectstore/object-store.js";
import { createApp } from "../routes.js";
import { createBackendServer } from "../server.js";
import { createResourceStore } from "../storage.js";
import { createTestAuth, type TestAuth } from "./test-auth.js";
import { startTestAuthz, type TestAuthz } from "./test-authz.js";
import { testMigrationSources } from "./test-migrations.js";
import { createTestPool } from "./test-pool.js";
import { makeTextPdf } from "./test-pdf.js";

const BUCKET = "ocr-sweep-test-documents";

/** Generous bound for tests that upload + run both sweeps; the vitest
 * default (5s) is too tight for pdfjs on a cold CI runner. */
const TEST_TIMEOUT_MS = 60_000;

/* ---------------------- the fake Document AI ------------------------ */

interface FakeDocAiRequest {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: {
    readonly rawDocument?: { readonly content?: string; readonly mimeType?: string };
    readonly imagelessMode?: unknown;
    readonly processOptions?: {
      readonly individualPageSelector?: { readonly pages?: readonly number[] };
    };
    readonly fieldMask?: string;
  } & Record<string, unknown>;
}

interface FakeResponse {
  readonly status: number;
  readonly json: unknown;
}

type FakeResponder = (request: FakeDocAiRequest) => FakeResponse;

interface FakeDocAi {
  readonly url: string;
  readonly requests: FakeDocAiRequest[];
  /** Replace the responder for one test. */
  respond(fn: FakeResponder): void;
  /** Restore the default auto-success responder (does NOT clear the
   * request log — counts accumulate across the suite on purpose, so
   * "no new requests" assertions diff a captured baseline). */
  restoreDefault(): void;
  close(): Promise<void>;
}

/** One page of a scripted success response. */
interface FakePageSpec {
  readonly page: number;
  readonly text: string;
  readonly languages?: readonly { languageCode: string; confidence: number }[];
  /** Emit TWO textAnchor segments for this page (a multi-segment
   * anchor — Google splits anchors freely, the adapter must reassemble). */
  readonly splitAnchor?: boolean;
}

/** Proto3 JSON: int64 offsets are STRINGS, and a zero startIndex is
 * OMITTED — the exact shapes the adapter documents handling. */
function anchorSegment(startByte: number, endByte: number): Record<string, string> {
  return {
    ...(startByte === 0 ? {} : { startIndex: String(startByte) }),
    endIndex: String(endByte),
  };
}

/** Builds a `:process` success body: document.text is the concatenation
 * of the page texts, and each page's textAnchor carries UTF-8 BYTE
 * offsets into it (the adapter must slice bytes, not code units —
 * Telugu is the proof case). */
function processSuccessBody(pages: readonly FakePageSpec[]): unknown {
  let text = "";
  const documentPages: unknown[] = [];
  for (const spec of pages) {
    const startByte = Buffer.byteLength(text, "utf8");
    text += spec.text;
    const endByte = Buffer.byteLength(text, "utf8");
    let segments: Record<string, string>[];
    if (spec.text.length === 0) {
      segments = [];
    } else if (spec.splitAnchor) {
      // Split at a code-point boundary roughly mid-text — two segments
      // that must concatenate byte-exactly.
      const midByte =
        startByte +
        Buffer.byteLength(spec.text.slice(0, Math.ceil(spec.text.length / 2)), "utf8");
      segments = [anchorSegment(startByte, midByte), anchorSegment(midByte, endByte)];
    } else {
      segments = [anchorSegment(startByte, endByte)];
    }
    documentPages.push({
      pageNumber: spec.page,
      ...(spec.languages ? { detectedLanguages: spec.languages } : {}),
      layout: { textAnchor: { textSegments: segments } },
    });
  }
  return { document: { text, pages: documentPages } };
}

/** Google's error envelope. */
function googleError(status: number, grpcStatus: string, message: string): FakeResponse {
  return { status, json: { error: { code: status, message, status: grpcStatus } } };
}

function selectorPages(request: FakeDocAiRequest): readonly number[] {
  return request.body.processOptions?.individualPageSelector?.pages ?? [];
}

/** Default responder: succeed with generic fictional text for exactly
 * the requested pages. */
function defaultResponder(request: FakeDocAiRequest): FakeResponse {
  return {
    status: 200,
    json: processSuccessBody(
      selectorPages(request).map((page) => ({
        page,
        text: `Fictional recognized text for page ${page}.`,
        languages: [{ languageCode: "en", confidence: 0.8 }],
      })),
    ),
  };
}

async function startFakeDocAi(): Promise<FakeDocAi> {
  const requests: FakeDocAiRequest[] = [];
  let responder: FakeResponder = defaultResponder;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method !== "POST" || !(req.url ?? "").endsWith(":process")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: 404, message: "unknown fake endpoint" } }));
        return;
      }
      const recorded: FakeDocAiRequest = {
        path: req.url ?? "",
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as FakeDocAiRequest["body"],
      };
      requests.push(recorded);
      const answer = responder(recorded);
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    respond(fn) {
      responder = fn;
    },
    restoreDefault() {
      responder = defaultResponder;
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

/* --------------------------- the suite ------------------------------ */

describe("the OCR sweep against a fake Document AI (DD-009)", () => {
  let pgContainer: StartedPostgreSqlContainer;
  let minio: StartedMinioContainer;
  let pool: pg.Pool;
  let server: http.Server;
  let base: string;
  let auth: TestAuth;
  let authz: TestAuthz;
  let engine: AuthorizationEngine;
  let store: ReturnType<typeof createResourceStore>;
  let objectStore: ObjectStore;
  let toolDeps: ToolDeps;
  /** The same deps with ocrEnabled true — the deployment where the
   * sweep actually runs; the honesty sentences flip on it. */
  let ocrToolDeps: ToolDeps;
  let fake: FakeDocAi;
  let provider: OcrProvider;

  let users: Client<typeof UserService>;
  let firmMembers: Client<typeof FirmMemberService>;
  let clients: Client<typeof ClientService>;
  let cases: Client<typeof CaseService>;

  const lead = {
    email: "kavya@firm.example",
    role: FirmRole.ASSOCIATE,
    userId: "",
    memberId: "",
  };
  const FILE_NUMBER = "OS/2026/042";
  let caseId = "";

  async function runTool(
    tool: string,
    email: string,
    args: Record<string, unknown>,
    deps: ToolDeps,
  ): Promise<CallToolResult> {
    const identity: CallerIdentity = { kind: "stigmer_user", value: email };
    const handlers = new Map<string, (a: unknown) => Promise<CallToolResult>>();
    const capturing = {
      registerTool(name: string, _config: unknown, handler: (a: unknown) => Promise<CallToolResult>) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;
    for (const register of FIRM_TOOL_REGISTRARS) {
      register(capturing, identity, deps);
    }
    const handler = handlers.get(tool);
    if (!handler) throw new Error(`no such tool registered: ${tool}`);
    return handler(args);
  }

  /** The registered description for one tool under the given deps —
   * the deployment-conditional honesty surface. */
  function toolDescription(tool: string, deps: ToolDeps): string {
    const configs = new Map<string, { description?: string }>();
    const capturing = {
      registerTool(name: string, config: { description?: string }) {
        configs.set(name, config);
      },
    } as unknown as McpServer;
    for (const register of FIRM_TOOL_REGISTRARS) {
      register(capturing, { kind: "stigmer_user", value: lead.email }, deps);
    }
    return configs.get(tool)?.description ?? "";
  }

  function textOf(result: CallToolResult): string {
    const first = result.content[0];
    return first?.type === "text" ? first.text : "";
  }

  /** Uploads through the REAL byte route, exactly as the MinIO suite. */
  async function upload(
    fileName: string,
    category: string,
    body: Uint8Array,
    mimeType = "application/pdf",
  ): Promise<string> {
    const res = await fetch(`${base}/files/cases/${caseId}/documents`, {
      method: "POST",
      headers: {
        ...auth.as(lead.userId).headers,
        "content-type": mimeType,
        "x-file-name": encodeURIComponent(fileName),
        "x-document-category": category,
      },
      body: Buffer.from(body),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { metadata?: { id?: string } };
    const id = json.metadata?.id ?? "";
    expect(id).toMatch(/^doc_/);
    return id;
  }

  async function documentById(id: string): Promise<Document> {
    return toolDeps.resources.documents.invoke.get(
      create(GetDocumentRequestSchema, { id }),
      { id: lead.userId, kind: "user" },
    );
  }

  async function pagesOf(id: string): Promise<DocumentPage[]> {
    const page = await toolDeps.resources.documentPages.invoke.list(
      create(ListDocumentPagesRequestSchema, { documentId: id, pageSize: 100 }),
      { id: lead.userId, kind: "user" },
    );
    return page.items as DocumentPage[];
  }

  function extractionSweepDeps(): ExtractionSweepDeps {
    return {
      store,
      objectStore,
      createDocumentPage: toolDeps.resources.documentPages.invoke.create as NonNullable<
        typeof toolDeps.resources.documentPages.invoke.create
      >,
      recordExtraction: toolDeps.resources.documents.invoke.recordExtraction,
    };
  }

  /** Runs the real extraction sweep and asserts the document was
   * parked in NO_TEXT_LAYER — the OCR sweep's queue predicate. */
  async function classifyAsNoTextLayer(id: string): Promise<void> {
    await runExtractionSweepOnce(extractionSweepDeps());
    const document = await documentById(id);
    expect(document.status?.extraction).toBe(ExtractionState.NO_TEXT_LAYER);
    expect(document.status?.pageCount).toBe(0);
  }

  async function runOcr(opts: { pagesPerTick?: number; backoff?: OcrBackoff } = {}): Promise<void> {
    await runOcrSweepOnce({
      store,
      objectStore,
      createDocumentPage: toolDeps.resources.documentPages.invoke.create as NonNullable<
        typeof toolDeps.resources.documentPages.invoke.create
      >,
      recordExtraction: toolDeps.resources.documents.invoke.recordExtraction,
      provider,
      pagesPerTick: opts.pagesPerTick ?? 200,
      ...(opts.backoff ? { backoff: opts.backoff } : {}),
    });
  }

  beforeAll(async () => {
    [pgContainer, minio, auth, authz, fake] = await Promise.all([
      new PostgreSqlContainer("postgres:17-alpine").start(),
      new MinioContainer("minio/minio:RELEASE.2024-12-13T22-19-12Z").start(),
      createTestAuth(),
      startTestAuthz(),
      startFakeDocAi(),
    ]);
    pool = createTestPool(pgContainer.getConnectionUri());
    await runMigrations(pool, testMigrationSources());
    engine = await authz.newEngine();
    store = createResourceStore(pool);

    const s3Config = {
      endpoint: minio.getConnectionUrl(),
      region: "auto",
      bucket: BUCKET,
      accessKeyId: minio.getUsername(),
      secretAccessKey: minio.getPassword(),
      forcePathStyle: true,
    };
    const s3 = new S3Client({
      endpoint: s3Config.endpoint,
      region: s3Config.region,
      credentials: { accessKeyId: s3Config.accessKeyId, secretAccessKey: s3Config.secretAccessKey },
      forcePathStyle: true,
    });
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    objectStore = createS3ObjectStore(s3Config);

    // The REAL adapter through its two test seams (document-ai.ts):
    // endpoint override → the fake; token source override → no
    // network auth. Everything else — windowing, anchors, error
    // classification — is the production code path.
    provider = createDocumentAiProvider({
      processor: "projects/fictional-firm-test/locations/us/processors/fake-ocr-processor",
      tokenSource: async () => "fake-test-token",
      endpointBaseUrl: fake.url,
    });

    server = createBackendServer({
      store,
      auth: auth.kit,
      authz: engine,
      credentials: createPgCredentialStore(pool),
      refreshTokens: createPgRefreshTokenStore(pool),
      activationCodes: createPgActivationCodeStore(pool),
      objectStore,
      dispatcher: new InProcessEventDispatcher(),
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const transport = createConnectTransport({ baseUrl: base, httpVersion: "1.1" });
    users = createClient(UserService, transport);
    firmMembers = createClient(FirmMemberService, transport);
    clients = createClient(ClientService, transport);
    cases = createClient(CaseService, transport);

    const toolApp = createApp({
      store,
      caller: auth.kit.resolver.fromConnect,
      authz: engine,
      credentials: createPgCredentialStore(pool),
      refreshTokens: createPgRefreshTokenStore(pool),
      activationCodes: createPgActivationCodeStore(pool),
    });
    toolDeps = {
      resources: toolApp.resources,
      resolveCallerIdentity: createCallerIdentityResolver(store),
      store,
      policy: toolApp.policy,
      fetchDocument: (url) => fetchRemoteDocument(url, { allowPrivateNetworks: true }),
      ocrEnabled: false,
      storeDocument: (input, caller) =>
        storeCaseDocument(
          {
            objectStore,
            createDocument: toolApp.resources.documents.invoke.create as NonNullable<
              typeof toolApp.resources.documents.invoke.create
            >,
          },
          input,
          caller,
        ),
    };
    ocrToolDeps = { ...toolDeps, ocrEnabled: true };

    const user = await users.create(
      create(UserSchema, { spec: { email: lead.email } }),
      auth.asOperator(),
    );
    lead.userId = user.metadata?.id ?? "";
    const member = await firmMembers.create(
      create(FirmMemberSchema, { spec: { userId: lead.userId, role: lead.role } }),
      auth.asOperator(),
    );
    lead.memberId = member.metadata?.id ?? "";
    await auth.mint(lead.userId);

    const client = await clients.create(
      create(ClientSchema, { spec: { displayName: "Vasundhara Agro Mills" } }),
      auth.as(lead.userId),
    );
    const matter = await cases.create(
      create(CaseSchema, {
        spec: {
          fileNumber: FILE_NUMBER,
          clientId: client.metadata?.id ?? "",
          clientRole: ClientRole.PLAINTIFF,
          opposingParties: [{ name: "Godavari Warehousing" }],
          forum: { forumKind: ForumKind.DISTRICT_COURT, name: "II Addl District Court" },
          caseType: "civil",
          leadLawyerId: lead.memberId,
        },
      }),
      auth.as(lead.userId),
    );
    caseId = matter.metadata?.id ?? "";
  }, 240_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await fake.close();
    await pool.end();
    await Promise.all([pgContainer.stop(), minio.stop(), authz.stop()]);
  });

  /* ------- 1. scan-shaped PDF success + honesty labels (+ 3a) -------- */

  // INVENTED Telugu (DD-A10 — fictional, never a customer's document):
  // "court judgment copy — list of exhibits attached".
  const TELUGU_PAGE_TEXT =
    "న్యాయస్థానం తీర్పు ప్రతి — సాక్ష్యాల జాబితా జతచేయబడింది. ఇది కల్పిత పరీక్షా పాఠ్యం.";
  const ENGLISH_PAGE_TEXT =
    "Certified copy of the decree in the fictional suit for recovery of dues.";

  it(
    "OCRs a scan-shaped PDF: NO_TEXT_LAYER → EXTRACTED, Telugu round-trips byte-identical, scan labels ride search and read — and a second sweep re-bills nothing",
    async () => {
      const bytes = makeTextPdf(["", "x"]); // stray-glyph scan, 2 physical pages
      const docId = await upload("scanned-decree-telugu.pdf", "order_judgment", bytes);
      await classifyAsNoTextLayer(docId);

      // NOTE: responders must never assert — they run inside the HTTP
      // handler where a throw is an uncaught exception, not a test
      // failure. Everything is asserted post-hoc from fake.requests.
      fake.respond(() => {
        return {
          status: 200,
          json: processSuccessBody([
            {
              page: 1,
              text: ENGLISH_PAGE_TEXT,
              languages: [{ languageCode: "en", confidence: 0.81 }],
            },
            {
              page: 2,
              text: TELUGU_PAGE_TEXT,
              // Two candidates — the adapter must keep the most
              // confident one.
              languages: [
                { languageCode: "te", confidence: 0.93 },
                { languageCode: "en", confidence: 0.31 },
              ],
              // The multi-segment anchor: byte-sliced halves that must
              // reassemble exactly.
              splitAnchor: true,
            },
          ]),
        };
      });
      const requestsBefore = fake.requests.length;
      await runOcr();

      // The wire contract the adapter promises (document-ai.ts):
      // ONE request (2 pages fit one ≤15 window), inline bytes,
      // imagelessMode at the TOP level, the seam token.
      expect(fake.requests.length).toBe(requestsBefore + 1);
      const request = fake.requests[requestsBefore] as FakeDocAiRequest;
      expect(selectorPages(request)).toEqual([1, 2]);
      expect(request.body.imagelessMode).toBe(true);
      expect(request.body.rawDocument?.mimeType).toBe("application/pdf");
      // rawDocument.content equality lives in its own test below —
      // the detached-buffer regression pin (review F1).
      expect(request.authorization).toBe("Bearer fake-test-token");
      expect(request.path).toContain("fake-ocr-processor:process");

      const swept = await documentById(docId);
      expect(swept.status?.extraction).toBe(ExtractionState.EXTRACTED);
      expect(swept.status?.pageCount).toBe(2);

      const pages = await pagesOf(docId);
      expect(pages.length).toBe(2);
      const [page1, page2] = pages as [DocumentPage, DocumentPage];
      expect(page1.spec?.page).toBe(1);
      expect(page1.spec?.text).toBe(ENGLISH_PAGE_TEXT);
      expect(page1.spec?.source).toBe(TextSource.OCR);
      expect(page1.spec?.language).toBe("en");
      // Byte-identical round trip: the exact invented Telugu string,
      // through UTF-8 anchor slicing, the pipeline, and Postgres.
      expect(page2.spec?.page).toBe(2);
      expect(page2.spec?.text).toBe(TELUGU_PAGE_TEXT);
      expect(page2.spec?.source).toBe(TextSource.OCR);
      expect(page2.spec?.language).toBe("te");
      expect(page2.spec?.confidence).toBeCloseTo(0.93, 2);

      // search_documents on the OCR-enabled deployment: the Telugu
      // word is found, qualified "(from a scan)".
      const found = await runTool(
        "search_documents",
        lead.email,
        { query: "న్యాయస్థానం" },
        ocrToolDeps,
      );
      expect(found.isError).toBeFalsy();
      expect(textOf(found)).toContain("scanned-decree-telugu.pdf");
      expect(textOf(found)).toContain("(from a scan)");
      const hits = (found.structuredContent as { hits: { from_scan?: boolean; page: number }[] })
        .hits;
      expect(hits[0]?.from_scan).toBe(true);
      expect(hits[0]?.page).toBe(2);

      // read_document labels the OCR page honestly, single-page and
      // whole-document forms both.
      const single = await runTool(
        "read_document",
        lead.email,
        { document_id: docId, page: 2 },
        ocrToolDeps,
      );
      expect(single.isError).toBeFalsy();
      expect(textOf(single)).toContain("read from a scan");
      expect(textOf(single)).toContain(TELUGU_PAGE_TEXT);
      const whole = await runTool("read_document", lead.email, { document_id: docId }, ocrToolDeps);
      expect(textOf(whole)).toContain("[page 1 — read from a scan]");

      // 3a. Idempotency: the document left the queue — another sweep
      // makes NO provider request and adds no pages.
      fake.restoreDefault();
      const countAfterSuccess = fake.requests.length;
      await runOcr();
      expect(fake.requests.length).toBe(countAfterSuccess);
      expect((await pagesOf(docId)).length).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  /* ------- the real-bytes contract (the detached-buffer trap) --------- */

  it(
    "sends the PDF's real bytes to the provider — page counting must not consume them",
    async () => {
      // The trap this pins: ocr-sweep.ts ocrOne() calls
      // countPdfPages(bytes) and then hands the SAME typed array to
      // provider.recognize(). pdfjs v6 getDocument({ data }) TRANSFERS
      // the array's ArrayBuffer, so without countPdfPages copying
      // internally (review F1) every PDF would be base64-encoded from
      // zero bytes and Document AI would receive rawDocument.content:
      // "" — against the real provider that is HTTP 400 and a wrong
      // terminal OCR_FAILED on every healthy scanned PDF.
      const bytes = makeTextPdf(["", "z"]);
      const docId = await upload("bytes-must-arrive.pdf", "evidence", bytes);
      await classifyAsNoTextLayer(docId);

      const before = fake.requests.length;
      await runOcr();

      expect(fake.requests.length).toBe(before + 1);
      const request = fake.requests[before] as FakeDocAiRequest;
      // THE CONTRACT: the provider receives the stored document's
      // actual bytes, untouched by the page counter.
      expect(request.body.rawDocument?.content).toBe(Buffer.from(bytes).toString("base64"));
    },
    TEST_TIMEOUT_MS,
  );

  /* ----------------------- 2. PNG image path ------------------------- */

  it(
    "OCRs a PNG in NO_TEXT_LAYER as a one-page document, sending its true image/png mime",
    async () => {
      const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 8, 9]);
      const docId = await upload("photographed-notice.png", "evidence", pngBytes, "image/png");
      await classifyAsNoTextLayer(docId);

      const before = fake.requests.length;
      await runOcr();

      expect(fake.requests.length).toBe(before + 1);
      const request = fake.requests[before] as FakeDocAiRequest;
      expect(request.body.rawDocument?.mimeType).toBe("image/png");
      expect(request.body.rawDocument?.content).toBe(Buffer.from(pngBytes).toString("base64"));
      expect(selectorPages(request)).toEqual([1]);

      const swept = await documentById(docId);
      expect(swept.status?.extraction).toBe(ExtractionState.EXTRACTED);
      expect(swept.status?.pageCount).toBe(1);
      const pages = await pagesOf(docId);
      expect(pages.length).toBe(1);
      expect(pages[0]?.spec?.source).toBe(TextSource.OCR);
    },
    TEST_TIMEOUT_MS,
  );

  /* ------------- 3b. resume-from-partial (mid-write crash) ----------- */

  it(
    "resumes from a partial write: all pages pre-written costs ZERO provider requests — only the status write remains",
    async () => {
      // The mid-write crash shape: a prior sweep landed every page but
      // died before recordExtraction — the document is still
      // NO_TEXT_LAYER with a full page set.
      const docId = await upload("crashed-mid-write.pdf", "evidence", makeTextPdf(["", "r"]));
      await classifyAsNoTextLayer(docId);
      const createPage = extractionSweepDeps().createDocumentPage;
      for (const page of [1, 2]) {
        await createPage(
          create(DocumentPageSchema, {
            spec: {
              documentId: docId,
              caseId,
              page,
              text: `Pre-written fictional OCR text, page ${page}.`,
              source: TextSource.OCR,
              language: "en",
              confidence: 0.7,
            },
          }),
          SYSTEM_PRINCIPAL,
        );
      }

      const before = fake.requests.length;
      await runOcr();

      // The resume-from-partial contract: nothing was re-billed.
      expect(fake.requests.length).toBe(before);
      const swept = await documentById(docId);
      expect(swept.status?.extraction).toBe(ExtractionState.EXTRACTED);
      expect(swept.status?.pageCount).toBe(2);
      // The surviving pages were kept, not overwritten.
      const pages = await pagesOf(docId);
      expect(pages.length).toBe(2);
      expect(pages[0]?.spec?.text).toBe("Pre-written fictional OCR text, page 1.");
    },
    TEST_TIMEOUT_MS,
  );

  /* ------------------ 4. terminal bytes-reject (400) ------------------ */

  it(
    "records HTTP 400 as terminal OCR_FAILED, never re-requests it, and read_document answers the approved sentence",
    async () => {
      const docId = await upload("unreadable-scan.pdf", "evidence", makeTextPdf(["", "f"]));
      await classifyAsNoTextLayer(docId);

      fake.respond(() =>
        googleError(400, "INVALID_ARGUMENT", "Unsupported input file format."),
      );
      const before = fake.requests.length;
      await runOcr();
      expect(fake.requests.length).toBe(before + 1);
      expect((await documentById(docId)).status?.extraction).toBe(ExtractionState.OCR_FAILED);
      expect((await pagesOf(docId)).length).toBe(0);

      // The trap: restore SUCCESS. If the sweep wrongly re-queued the
      // document, this second pass would succeed and flip the status —
      // instead it must make no request at all (OCR_FAILED is not in
      // the NO_TEXT_LAYER queue).
      fake.restoreDefault();
      const afterFirst = fake.requests.length;
      await runOcr();
      expect(fake.requests.length).toBe(afterFirst);
      expect((await documentById(docId)).status?.extraction).toBe(ExtractionState.OCR_FAILED);

      const answer = await runTool(
        "read_document",
        lead.email,
        { document_id: docId },
        ocrToolDeps,
      );
      expect(answer.isError).toBe(true);
      expect(textOf(answer)).toContain(
        "The system tried to read this scan and couldn't make out the text — I " +
          "can only tell you what's recorded about it (name, category, upload). " +
          "A person will need to open the file itself.",
      );
    },
    TEST_TIMEOUT_MS,
  );

  /* ------------- 5. config error stays retryable (403) ---------------- */

  it(
    "leaves a document NO_TEXT_LAYER on HTTP 403 (no document verdict — session-14) and succeeds on the very next sweep once fixed",
    async () => {
      const docId = await upload("during-outage.pdf", "correspondence", makeTextPdf(["", "g"]));
      await classifyAsNoTextLayer(docId);

      fake.respond(() =>
        googleError(403, "PERMISSION_DENIED", "Caller lacks documentai.processors.processOnline."),
      );
      // A REAL backoff shared across both sweeps: a configuration
      // error must not have recorded a per-document failure, so the
      // immediate retry below must be eligible — the session-14
      // regression guard.
      const backoff = createOcrBackoff(60_000);
      const before = fake.requests.length;
      await runOcr({ backoff });
      expect(fake.requests.length).toBe(before + 1);
      const during = await documentById(docId);
      expect(during.status?.extraction).toBe(ExtractionState.NO_TEXT_LAYER);
      expect((await pagesOf(docId)).length).toBe(0);

      // Fix the "credentials" and sweep again immediately — same
      // backoff, no waiting: the document retries and completes.
      fake.restoreDefault();
      await runOcr({ backoff });
      expect(fake.requests.length).toBe(before + 2);
      expect((await documentById(docId)).status?.extraction).toBe(ExtractionState.EXTRACTED);
    },
    TEST_TIMEOUT_MS,
  );

  /* ------------------- 6. transient 429 + backoff --------------------- */

  it(
    "backs off a 429 document without stranding the queue: the healthy neighbor processes the same tick, the failer is skipped next tick",
    async () => {
      // Failing document FIRST (createdAt asc is the queue order).
      const failingId = await upload("rate-limited.pdf", "evidence", makeTextPdf(["", "j"]));
      const healthyId = await upload("healthy-neighbor.pdf", "evidence", makeTextPdf(["", "k"]));
      await classifyAsNoTextLayer(failingId);
      expect((await documentById(healthyId)).status?.extraction).toBe(
        ExtractionState.NO_TEXT_LAYER,
      );

      // The failer is distinguished by REQUEST ORDER (first in the
      // queue → first request of the tick), not by content — simpler,
      // and independent of how the payload is encoded.
      let calls = 0;
      fake.respond((request) =>
        calls++ === 0
          ? googleError(429, "RESOURCE_EXHAUSTED", "Quota exceeded for quota metric.")
          : defaultResponder(request),
      );

      const backoff = createOcrBackoff(60_000);
      const before = fake.requests.length;
      await runOcr({ backoff });

      // Tick 1: both were attempted — the flaky first document did not
      // strand the healthy second.
      expect(fake.requests.length).toBe(before + 2);
      expect((await documentById(failingId)).status?.extraction).toBe(
        ExtractionState.NO_TEXT_LAYER,
      );
      expect((await documentById(healthyId)).status?.extraction).toBe(ExtractionState.EXTRACTED);

      // Tick 2, immediately: the failer is inside its backoff window —
      // ZERO new provider requests.
      await runOcr({ backoff });
      expect(fake.requests.length).toBe(before + 2);
      expect((await documentById(failingId)).status?.extraction).toBe(
        ExtractionState.NO_TEXT_LAYER,
      );

      // No starvation (review F7): with the backed-off failer still at
      // the HEAD of the createdAt-ordered queue, a document uploaded
      // after it processes the SAME tick — the sweep skips ineligible
      // rows and spends its slots on eligible ones.
      fake.restoreDefault();
      const freshId = await upload("uploaded-during-backoff.pdf", "evidence", makeTextPdf(["", "q"]));
      await classifyAsNoTextLayer(freshId);
      const beforeFresh = fake.requests.length;
      await runOcr({ backoff });
      expect(fake.requests.length).toBe(beforeFresh + 1);
      expect((await documentById(freshId)).status?.extraction).toBe(ExtractionState.EXTRACTED);
      expect((await documentById(failingId)).status?.extraction).toBe(
        ExtractionState.NO_TEXT_LAYER,
      );

      // Queue hygiene for the tests that follow: a fresh backoff (a
      // restarted replica) retries and completes the failer.
      await runOcr({ backoff: createOcrBackoff(60_000) });
      expect((await documentById(failingId)).status?.extraction).toBe(ExtractionState.EXTRACTED);
    },
    TEST_TIMEOUT_MS,
  );

  /* ------------------------ 7. the page budget ------------------------ */

  it(
    "defers the second document when the budget is spent, and still processes an oversized document when it heads the tick",
    async () => {
      const firstId = await upload("budget-first.pdf", "evidence", makeTextPdf(["", "m"]));
      const secondId = await upload("budget-second.pdf", "evidence", makeTextPdf(["", "n"]));
      await classifyAsNoTextLayer(firstId);
      expect((await documentById(secondId)).status?.extraction).toBe(
        ExtractionState.NO_TEXT_LAYER,
      );

      // Budget 3, two 2-page documents: the first spends 2, the second
      // needs 2 > 1 remaining → the tick stops (arrival order, never a
      // queue jump).
      const before = fake.requests.length;
      await runOcr({ pagesPerTick: 3 });
      expect(fake.requests.length).toBe(before + 1);
      expect((await documentById(firstId)).status?.extraction).toBe(ExtractionState.EXTRACTED);
      expect((await documentById(secondId)).status?.extraction).toBe(
        ExtractionState.NO_TEXT_LAYER,
      );

      // The next tick picks the deferred document up.
      await runOcr({ pagesPerTick: 3 });
      expect(fake.requests.length).toBe(before + 2);
      expect((await documentById(secondId)).status?.extraction).toBe(ExtractionState.EXTRACTED);

      // A 5-page document against a 3-page budget, as the tick's FIRST
      // document: processed whole — it could never run otherwise.
      const oversizedId = await upload(
        "budget-oversized.pdf",
        "evidence",
        makeTextPdf(["", "", "", "", "p"]),
      );
      await classifyAsNoTextLayer(oversizedId);
      await runOcr({ pagesPerTick: 3 });
      expect(fake.requests.length).toBe(before + 3);
      expect(selectorPages(fake.requests[fake.requests.length - 1] as FakeDocAiRequest)).toEqual([
        1, 2, 3, 4, 5,
      ]);
      const oversized = await documentById(oversizedId);
      expect(oversized.status?.extraction).toBe(ExtractionState.EXTRACTED);
      expect(oversized.status?.pageCount).toBe(5);
    },
    TEST_TIMEOUT_MS,
  );

  /* ----------------------- 8. page windows (>15) ---------------------- */

  it(
    "windows a 17-page scan into ≤15-page :process calls that partition 1..17, and writes each page exactly once",
    async () => {
      const seventeenPages = Array.from({ length: 17 }, (_, i) => (i === 16 ? "x" : ""));
      const docId = await upload("seventeen-page-scan.pdf", "evidence", makeTextPdf(seventeenPages));
      await classifyAsNoTextLayer(docId);

      const before = fake.requests.length;
      await runOcr();

      const windows = fake.requests.slice(before).map((r) => [...selectorPages(r)]);
      expect(windows.length).toBe(2);
      for (const window of windows) {
        expect(window.length).toBeLessThanOrEqual(15);
      }
      // The windows PARTITION 1..17: every page exactly once, no
      // overlap, no gap.
      const allRequested = windows.flat().sort((a, b) => a - b);
      expect(allRequested).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));

      const swept = await documentById(docId);
      expect(swept.status?.extraction).toBe(ExtractionState.EXTRACTED);
      expect(swept.status?.pageCount).toBe(17);
      const writtenPages = (await pagesOf(docId))
        .map((p) => p.spec?.page ?? 0)
        .sort((a, b) => a - b);
      expect(writtenPages).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    },
    TEST_TIMEOUT_MS,
  );

  /* ---------- 8b. mid-document batch failure (review F6) -------------- */

  it(
    "keeps batch 1's pages when batch 2 fails transiently, and the retry requests ONLY the missing pages",
    async () => {
      const seventeenPages = Array.from({ length: 17 }, (_, i) => (i === 16 ? "w" : ""));
      const docId = await upload("partial-batches.pdf", "evidence", makeTextPdf(seventeenPages));
      await classifyAsNoTextLayer(docId);

      // Batch 1 ([1..15]) succeeds; batch 2 ([16,17], recognized by
      // its 2-page selector) answers 429 — the transient shape.
      fake.respond((request) =>
        selectorPages(request).length === 2
          ? googleError(429, "RESOURCE_EXHAUSTED", "Quota exceeded for quota metric.")
          : defaultResponder(request),
      );
      const before = fake.requests.length;
      await runOcr();

      // Both batches were ATTEMPTED (billed); batch 1's 15 pages are
      // WRITTEN — a mid-document failure discards nothing — and the
      // document stays NO_TEXT_LAYER (status only after EVERY batch).
      expect(fake.requests.length).toBe(before + 2);
      expect((await documentById(docId)).status?.extraction).toBe(ExtractionState.NO_TEXT_LAYER);
      const survivors = (await pagesOf(docId)).map((p) => p.spec?.page ?? 0).sort((a, b) => a - b);
      expect(survivors).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));

      // The retry re-bills NOTHING that landed: its single request
      // selects only the two unanswered pages — resume-from-partial
      // saving real money.
      fake.restoreDefault();
      await runOcr();
      expect(fake.requests.length).toBe(before + 3);
      expect(selectorPages(fake.requests[before + 2] as FakeDocAiRequest)).toEqual([16, 17]);
      const swept = await documentById(docId);
      expect(swept.status?.extraction).toBe(ExtractionState.EXTRACTED);
      expect(swept.status?.pageCount).toBe(17);
      expect((await pagesOf(docId)).length).toBe(17);
    },
    TEST_TIMEOUT_MS,
  );

  /* ---------- 8c. response coverage check (review F2) ------------------ */

  it(
    "refuses a response that omits a requested page: no rows written, NO_TEXT_LAYER kept, retried next sweep",
    async () => {
      const docId = await upload("half-answered.pdf", "evidence", makeTextPdf(["", "v"]));
      await classifyAsNoTextLayer(docId);

      // The provider answers page 1 of the requested [1, 2] —
      // fieldMask drift and 200-with-error-body reduce to this same
      // shape. DocumentPage rows are immutable and EXTRACTED dequeues
      // forever, so writing page 2 blank would be permanent.
      fake.respond((request) => ({
        status: 200,
        json: processSuccessBody([
          { page: selectorPages(request)[0] ?? 1, text: "the only answered page" },
        ]),
      }));
      const before = fake.requests.length;
      await runOcr();

      expect(fake.requests.length).toBe(before + 1);
      expect((await documentById(docId)).status?.extraction).toBe(ExtractionState.NO_TEXT_LAYER);
      expect((await pagesOf(docId)).length).toBe(0);

      // Transient by classification: the next sweep retries and, with
      // a full answer, completes normally.
      fake.restoreDefault();
      await runOcr();
      expect(fake.requests.length).toBe(before + 2);
      expect((await documentById(docId)).status?.extraction).toBe(ExtractionState.EXTRACTED);
      expect((await pagesOf(docId)).length).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  /* ------- 8d. unrecognized 400 is config, not a verdict (F3) ---------- */

  it(
    "leaves a document NO_TEXT_LAYER on a 400 with an unrecognized message — a request-shape bug must never stamp OCR_FAILED",
    async () => {
      const docId = await upload("shape-bug-victim.pdf", "evidence", makeTextPdf(["", "u"]));
      await classifyAsNoTextLayer(docId);

      // A 400 whose message is NOT a known verdict about the bytes:
      // our own request-shape bugs answer exactly this way (the
      // session-14 principle — machinery state must not be written as
      // document state).
      fake.respond(() =>
        googleError(400, "INVALID_ARGUMENT", "Invalid field mask path: pages.bogus"),
      );
      const backoff = createOcrBackoff(60_000);
      const before = fake.requests.length;
      await runOcr({ backoff });

      expect(fake.requests.length).toBe(before + 1);
      expect((await documentById(docId)).status?.extraction).toBe(ExtractionState.NO_TEXT_LAYER);
      expect((await pagesOf(docId)).length).toBe(0);

      // Classified CONFIGURATION: no per-document failure recorded, so
      // the immediate retry (same backoff) is eligible and completes.
      fake.restoreDefault();
      await runOcr({ backoff });
      expect(fake.requests.length).toBe(before + 2);
      expect((await documentById(docId)).status?.extraction).toBe(ExtractionState.EXTRACTED);
    },
    TEST_TIMEOUT_MS,
  );

  /* -------------------------- 9. blank scan --------------------------- */

  it(
    "writes EMPTY pages for a blank scan and answers EXTRACTED — page numbers must match the physical document",
    async () => {
      const docId = await upload("blank-scan.pdf", "evidence", makeTextPdf(["", "b"]));
      await classifyAsNoTextLayer(docId);

      fake.respond((request) => ({
        status: 200,
        json: processSuccessBody(
          selectorPages(request).map((page) => ({ page, text: "" })),
        ),
      }));
      await runOcr();

      const swept = await documentById(docId);
      expect(swept.status?.extraction).toBe(ExtractionState.EXTRACTED);
      expect(swept.status?.pageCount).toBe(2);
      const pages = await pagesOf(docId);
      expect(pages.length).toBe(2);
      expect(pages.map((p) => p.spec?.page)).toEqual([1, 2]);
      expect(pages.every((p) => (p.spec?.text ?? "x") === "")).toBe(true);
      expect(pages.every((p) => p.spec?.source === TextSource.OCR)).toBe(true);
      fake.restoreDefault();
    },
    TEST_TIMEOUT_MS,
  );

  /* ----------------- 10. honesty in both deployments ------------------ */

  it(
    "flips every honesty sentence on ocrEnabled: tool descriptions, the zero-hit search line, and the NO_TEXT_LAYER read sentence",
    async () => {
      // A scan the OCR sweep has NOT touched — the state both
      // deployments must describe honestly, differently. (Last test in
      // the file on purpose: this document stays NO_TEXT_LAYER.)
      const docId = await upload("still-unread-scan.pdf", "evidence", makeTextPdf(["", "h"]));
      await classifyAsNoTextLayer(docId);

      // read_document, OCR off: the legacy honest refusal.
      const legacyRead = await runTool(
        "read_document",
        lead.email,
        { document_id: docId },
        toolDeps,
      );
      expect(legacyRead.isError).toBe(true);
      expect(textOf(legacyRead)).toContain(
        "This document is a scan or photo, and I can't read those yet — I can " +
          "only tell you what's recorded about it (name, category, upload). A " +
          "person will need to open the file itself.",
      );

      // read_document, OCR on: the "being read" promise.
      const ocrRead = await runTool(
        "read_document",
        lead.email,
        { document_id: docId },
        ocrToolDeps,
      );
      expect(ocrRead.isError).toBe(true);
      expect(textOf(ocrRead)).toContain(
        "This document is a scan or photo and is being read — its text is " +
          "usually ready within a few minutes. Try again shortly.",
      );

      // The zero-hit search sentence, both ways (a query nothing
      // matches — unique gibberish).
      const legacyMiss = await runTool(
        "search_documents",
        lead.email,
        { query: "zxqv-unfindable-9137" },
        toolDeps,
      );
      expect(textOf(legacyMiss)).toContain("scanned documents are not searchable yet.");
      const ocrMiss = await runTool(
        "search_documents",
        lead.email,
        { query: "zxqv-unfindable-9137" },
        ocrToolDeps,
      );
      expect(textOf(ocrMiss)).toContain("recently uploaded scans may still be being read.");
      expect(textOf(ocrMiss)).not.toContain("not searchable");

      // The registered descriptions — what the model reads before ever
      // calling the tool.
      expect(toolDescription("search_documents", toolDeps)).toContain(
        "Scanned documents and photos are not searchable yet.",
      );
      expect(toolDescription("search_documents", ocrToolDeps)).toContain(
        "Scanned documents and photos become searchable a few minutes after " +
          "upload, once the system has read them.",
      );
      expect(toolDescription("read_document", toolDeps)).not.toContain("read automatically");
      expect(toolDescription("read_document", ocrToolDeps)).toContain(
        "Scans and photos are read automatically a few minutes after upload.",
      );
    },
    TEST_TIMEOUT_MS,
  );
});
