/**
 * Document intelligence, end to end (FR-DOC-001/002/004): the byte
 * routes against REAL MinIO through the real S3 client (the same
 * configuration shape as production R2 — this suite is the "MinIO
 * suite" the memory object store's header promises), and the
 * assistant's document tools through the real gate, the real caller
 * resolver, and the real policy + FGA engine.
 *
 * The tools are invoked at the registrar seam (the agent-manifest
 * test's capturing arrangement, with the handlers kept): tool logic,
 * gate, pipelines, and policy all run for real; only the MCP wire
 * framing is absent, and that framing is proven by the bundle suite
 * and the ops smoke.
 *
 * The visibility contract under test everywhere: a document is case
 * content — whoever cannot open the case can never see the document,
 * its metadata, or (Level 2) a snippet of its text, through ANY verb.
 */

import type http from "node:http";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import { CreateBucketCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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
import { CaseMemberSchema, CaseMemberService, RoleOnCase } from "../gen/stigmer/law/casemember/v1/casemember_pb.js";
import { ClientSchema, ClientService } from "../gen/stigmer/law/client/v1/client_pb.js";
import {
  type Document,
  ExtractionState,
  GetDocumentRequestSchema,
  ListDocumentsRequestSchema,
  RecordDocumentExtractionRequestSchema,
} from "../gen/stigmer/law/document/v1/document_pb.js";
import {
  type DocumentPage,
  DocumentPageSchema,
  ListDocumentPagesRequestSchema,
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
import { storeCaseDocument } from "../domain/document/store-document.js";
import { fetchRemoteDocument } from "../files/remote-fetch.js";
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
import { makeNulGlyphPdf, makeTextPdf } from "./test-pdf.js";

const BUCKET = "doc-intel-test-documents";

describe("document intelligence, end to end", () => {
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
  let s3: S3Client;
  let toolDeps: ToolDeps;

  let users: Client<typeof UserService>;
  let firmMembers: Client<typeof FirmMemberService>;
  let clients: Client<typeof ClientService>;
  let cases: Client<typeof CaseService>;
  let caseMembers: Client<typeof CaseMemberService>;

  const people = {
    partner: { email: "meera@firm.example", role: FirmRole.MANAGING_PARTNER, userId: "", memberId: "" },
    // The case's lead (membership materialized by the lead handler).
    lead: { email: "arjun@firm.example", role: FirmRole.ASSOCIATE, userId: "", memberId: "" },
    // Firm staff with NO membership on either matter — the outsider
    // every visibility assertion is about.
    outsider: { email: "divya@firm.example", role: FirmRole.ASSOCIATE, userId: "", memberId: "" },
    // Office staff never work case content (the role gate the
    // attach_document pre-authorization must fire for).
    office: { email: "kiran@firm.example", role: FirmRole.OFFICE_STAFF, userId: "", memberId: "" },
  };

  const FILE_A = "CS/2026/101";
  const FILE_B = "ARB/2026/007";
  let caseAId = "";
  let caseBId = "";
  /** The three-page written statement, set by the sweep test — the
   * document later page-read and verb tests cite. */
  let extractedDocId = "";

  /** Runs one tool as the given signed-in web user — the production
   * identity shape (stigmer_user/email), resolved by the real resolver
   * inside the real gate. */
  async function runTool(
    tool: string,
    email: string | undefined,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const identity: CallerIdentity | undefined = email
      ? { kind: "stigmer_user", value: email }
      : undefined;
    const handlers = new Map<string, (a: unknown) => Promise<CallToolResult>>();
    const capturing = {
      registerTool(name: string, _config: unknown, handler: (a: unknown) => Promise<CallToolResult>) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;
    for (const register of FIRM_TOOL_REGISTRARS) {
      register(capturing, identity, toolDeps);
    }
    const handler = handlers.get(tool);
    if (!handler) throw new Error(`no such tool registered: ${tool}`);
    return handler(args);
  }

  function textOf(result: CallToolResult): string {
    const first = result.content[0];
    return first?.type === "text" ? first.text : "";
  }

  /** Uploads through the REAL byte route — headers, cap, policy
   * pre-check, object-first ordering, pipeline create. */
  async function upload(
    email: string,
    caseId: string,
    fileName: string,
    category: string,
    body: Uint8Array | string,
    mimeType = "application/pdf",
  ): Promise<{ status: number; json: { metadata?: { id?: string } } & Record<string, unknown> }> {
    const person = Object.values(people).find((p) => p.email === email);
    if (!person) throw new Error(`unknown test person ${email}`);
    const res = await fetch(`${base}/files/cases/${caseId}/documents`, {
      method: "POST",
      headers: {
        ...auth.as(person.userId).headers,
        "content-type": mimeType,
        "x-file-name": encodeURIComponent(fileName),
        ...(category ? { "x-document-category": category } : {}),
      },
      body: typeof body === "string" ? Buffer.from(body) : Buffer.from(body),
    });
    return { status: res.status, json: (await res.json()) as never };
  }

  beforeAll(async () => {
    [pgContainer, minio, auth, authz] = await Promise.all([
      new PostgreSqlContainer("postgres:17-alpine").start(),
      new MinioContainer("minio/minio:RELEASE.2024-12-13T22-19-12Z").start(),
      createTestAuth(),
      startTestAuthz(),
    ]);
    pool = createTestPool(pgContainer.getConnectionUri());
    await runMigrations(pool, testMigrationSources());
    engine = await authz.newEngine();
    store = createResourceStore(pool);

    // The real S3 client against MinIO — production's configuration
    // shape (endpoint override + path style), per object-store.ts.
    const s3Config = {
      endpoint: minio.getConnectionUrl(),
      region: "auto",
      bucket: BUCKET,
      accessKeyId: minio.getUsername(),
      secretAccessKey: minio.getPassword(),
      forcePathStyle: true,
    };
    s3 = new S3Client({
      endpoint: s3Config.endpoint,
      region: s3Config.region,
      credentials: { accessKeyId: s3Config.accessKeyId, secretAccessKey: s3Config.secretAccessKey },
      forcePathStyle: true,
    });
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    objectStore = createS3ObjectStore(s3Config);

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
    caseMembers = createClient(CaseMemberService, transport);

    // The tools' production dependency shape (server.ts): pipelines
    // composed over the SAME store, the caller resolver reading that
    // store directly (the sweep test's second-assembly precedent).
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
      // The guard's test seam: the MinIO container lives on plain-http
      // loopback (remote-fetch.ts documents this as the seam's ONE
      // purpose). Everything else is the production posture.
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

    // The firm: users + profiles through the operator path.
    for (const person of Object.values(people)) {
      const user = await users.create(
        create(UserSchema, { spec: { email: person.email } }),
        auth.asOperator(),
      );
      person.userId = user.metadata?.id ?? "";
      const member = await firmMembers.create(
        create(FirmMemberSchema, { spec: { userId: person.userId, role: person.role } }),
        auth.asOperator(),
      );
      person.memberId = member.metadata?.id ?? "";
    }
    await auth.mint(...Object.values(people).map((p) => p.userId));

    // Two matters with the same lead; the outsider is on NEITHER.
    const client = await clients.create(
      create(ClientSchema, { spec: { displayName: "Meridian Textiles" } }),
      auth.as(people.lead.userId),
    );
    for (const [file, assign] of [
      [FILE_A, (id: string) => (caseAId = id)],
      [FILE_B, (id: string) => (caseBId = id)],
    ] as const) {
      const matter = await cases.create(
        create(CaseSchema, {
          spec: {
            fileNumber: file,
            clientId: client.metadata?.id ?? "",
            clientRole: ClientRole.PLAINTIFF,
            opposingParties: [{ name: "Sunrise Traders" }],
            forum: { forumKind: ForumKind.DISTRICT_COURT, name: "III Addl District Court" },
            caseType: "civil",
            leadLawyerId: people.lead.memberId,
          },
        }),
        auth.as(people.lead.userId),
      );
      assign(matter.metadata?.id ?? "");
    }
    // The partner joins case A explicitly (partners can read everything
    // anyway; membership makes the case-member arm testable too).
    await caseMembers.create(
      create(CaseMemberSchema, {
        spec: { caseId: caseAId, memberId: people.partner.memberId, roleOnCase: RoleOnCase.LAWYER },
      }),
      auth.as(people.lead.userId),
    );
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await pool.end();
    await Promise.all([pgContainer.stop(), minio.stop(), authz.stop()]);
  });

  /* ------------- the byte routes against real MinIO (FR-DOC-001) ------ */

  it("uploads land in the bucket and download streams them back to a member", async () => {
    const pdfish = "%PDF-1.4 fictional pleading body — suit for recovery";
    const uploaded = await upload(people.lead.email, caseAId, "plaint.pdf", "pleading", pdfish);
    expect(uploaded.status).toBe(201);
    const id = uploaded.json.metadata?.id ?? "";
    expect(id).toMatch(/^doc_/);

    const download = await fetch(`${base}/files/documents/${id}/content`, {
      headers: auth.as(people.lead.userId).headers,
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe(pdfish);
  });

  it("refuses an outsider's download with the policy's sentence — bytes are case content", async () => {
    const uploaded = await upload(
      people.lead.email,
      caseAId,
      "order-2026-06-01.pdf",
      "order_judgment",
      "%PDF-1.4 interim order",
    );
    const id = uploaded.json.metadata?.id ?? "";
    const denied = await fetch(`${base}/files/documents/${id}/content`, {
      headers: auth.as(people.outsider.userId).headers,
    });
    expect(denied.status).toBe(403);
  });

  /* ----------------- find_documents (FR-DOC-004, Level 1) ------------- */

  it("lists a matter's file for a member, newest first, ids riding the lines", async () => {
    const result = await runTool("find_documents", people.lead.email, { file_number: FILE_A });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("plaint.pdf");
    expect(text).toContain("order-2026-06-01.pdf");
    expect(text).toMatch(/id doc_/);
    const structured = result.structuredContent as { documents: { id: string }[] };
    expect(structured.documents.length).toBeGreaterThanOrEqual(2);
  });

  it("narrows by category within the matter", async () => {
    const result = await runTool("find_documents", people.lead.email, {
      file_number: FILE_A,
      category: "pleading",
    });
    const text = textOf(result);
    expect(text).toContain("plaint.pdf");
    expect(text).not.toContain("order-2026-06-01.pdf");
  });

  it("relays the membership denial verbatim to a non-member — no redacted list", async () => {
    const result = await runTool("find_documents", people.outsider.email, {
      file_number: FILE_A,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/case members and partners/);
  });

  it("the firm-wide judgment collection scopes to the caller's visible cases", async () => {
    // A judgment on case B — the lead sees it, the outsider must not,
    // even through the firm-wide view.
    await upload(
      people.lead.email,
      caseBId,
      "silverline-v-sunrise-award.pdf",
      "judgment",
      "%PDF-1.4 arbitral award text",
    );

    const leadView = await runTool("find_documents", people.lead.email, { category: "judgment" });
    expect(textOf(leadView)).toContain("silverline-v-sunrise-award.pdf");
    // The cross-case view names each hit's matter.
    expect(textOf(leadView)).toContain(FILE_B);

    const partnerView = await runTool("find_documents", people.partner.email, {
      category: "judgment",
    });
    // Partners see the whole firm's collection (they can open any case).
    expect(textOf(partnerView)).toContain("silverline-v-sunrise-award.pdf");

    const outsiderView = await runTool("find_documents", people.outsider.email, {
      category: "judgment",
    });
    expect(outsiderView.isError).toBeFalsy();
    expect(textOf(outsiderView)).not.toContain("silverline-v-sunrise-award.pdf");
  });

  it("teaches the two sanctioned scopes when called with neither", async () => {
    const result = await runTool("find_documents", people.lead.email, {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/file number/);
    expect(textOf(result)).toMatch(/judgment/);
  });

  /* ------------- the citation library (FR-CIT-001) ------------------- */

  it("FR-CIT-001: a use is recorded against a library judgment and answers from both directions", async () => {
    const uploaded = await upload(
      people.lead.email,
      caseBId,
      "kesar-v-state-bail-order.pdf",
      "judgment",
      "%PDF-1.4 bail order text",
    );
    const judgmentId = uploaded.json.metadata?.id ?? "";
    expect(judgmentId).not.toBe("");

    const recorded = await runTool("record_citation_use", people.lead.email, {
      document_id: judgmentId,
      file_number: FILE_A,
      proposition: "bail where the offence carries under seven years",
    });
    expect(recorded.isError).toBeFalsy();
    expect(textOf(recorded)).toContain(FILE_A);

    // By matter: "what did we rely on here?"
    const byCase = await runTool("find_citation_uses", people.lead.email, {
      file_number: FILE_A,
    });
    expect(textOf(byCase)).toContain("kesar-v-state-bail-order.pdf");
    expect(textOf(byCase)).toContain("under seven years");

    // By judgment: "has this precedent worked for us?"
    const byDocument = await runTool("find_citation_uses", people.lead.email, {
      document_id: judgmentId,
    });
    expect(textOf(byDocument)).toContain(FILE_A);
  });

  it("FR-CIT-001: only judgment-collection documents can be cited — the library stays one pile", async () => {
    const evidence = await upload(
      people.lead.email,
      caseAId,
      "site-photos.pdf",
      "evidence",
      "%PDF-1.4 photos",
    );
    const result = await runTool("record_citation_use", people.lead.email, {
      document_id: evidence.json.metadata?.id ?? "",
      file_number: FILE_A,
      proposition: "should be refused",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/judgment collection/);
  });

  it("FR-CIT-001: the reliance trail is never wider than the caller's case visibility", async () => {
    // The outsider works neither matter: the trail answers empty for
    // them, and recording on someone else's matter is refused.
    const trail = await runTool("find_citation_uses", people.outsider.email, {});
    expect(trail.isError).toBeFalsy();
    expect(textOf(trail)).not.toContain("kesar-v-state-bail-order.pdf");

    const denied = await runTool("find_citation_uses", people.outsider.email, {
      file_number: FILE_A,
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toMatch(/case members and partners/);
  });

  /* ------------- the statutory frame's verb (FR-ACT-001) ------------- */

  it("FR-ACT-001: add_case_act records dictated acts, and the case story recites the frame", async () => {
    const added = await runTool("add_case_act", people.lead.email, {
      file_number: FILE_A,
      act: "IPC",
      sections: ["420", "468"],
      note: "the fraud counts",
    });
    expect(added.isError).toBeFalsy();
    expect(textOf(added)).toContain("IPC");

    const story = await runTool("case_story", people.lead.email, { file_number: FILE_A });
    expect(textOf(story)).toMatch(/Acts & sections/);
    expect(textOf(story)).toContain("IPC — 420, 468");
  });

  it("refuses an unknown web caller with the administrator sentence", async () => {
    const result = await runTool("find_documents", "nobody@firm.example", {
      file_number: FILE_A,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/administrator/i);
  });

  /* ------------------- case_story carries the file ------------------- */

  it("case_story answers with the documents section", async () => {
    const result = await runTool("case_story", people.lead.email, { file_number: FILE_A });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toMatch(/Documents on file/);
    expect(text).toContain("plaint.pdf");
  });

  /* ------------- the extraction sweep (FR-DOC-003, Level 2) ---------- */

  async function documentById(id: string): Promise<Document> {
    return toolDeps.resources.documents.invoke.get(
      create(GetDocumentRequestSchema, { id }),
      { id: people.lead.userId, kind: "user" },
    );
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

  it("the sweep extracts a text-layer PDF into page rows and answers EXTRACTED — idempotently", async () => {
    const uploaded = await upload(
      people.lead.email,
      caseAId,
      "written-statement.pdf",
      "pleading",
      makeTextPdf([
        "The suit is barred by limitation under Article 113 of the Limitation Act.",
        "", // a blank page — page numbers must still match the physical document
        "The defendant craves leave to refer to the arbitration agreement dated 1 June 2024.",
      ]),
    );
    expect(uploaded.status).toBe(201);
    const id = uploaded.json.metadata?.id ?? "";
    extractedDocId = id;

    // Fresh upload: unanswered until the first sweep.
    expect((await documentById(id)).status?.extraction ?? ExtractionState.UNSPECIFIED).toBe(
      ExtractionState.UNSPECIFIED,
    );

    await runExtractionSweepOnce(extractionSweepDeps());
    const afterFirst = await documentById(id);
    expect(afterFirst.status?.extraction).toBe(ExtractionState.EXTRACTED);
    expect(afterFirst.status?.pageCount).toBe(3);

    const pages = await toolDeps.resources.documentPages.invoke.list(
      create(ListDocumentPagesRequestSchema, { documentId: id, pageSize: 100 }),
      { id: people.lead.userId, kind: "user" },
    );
    expect(Number(pages.totalCount)).toBe(3);
    expect((pages.items[0] as DocumentPage).spec?.page).toBe(1);
    expect((pages.items[0] as DocumentPage).spec?.text).toContain("barred by limitation");
    expect((pages.items[1] as DocumentPage).spec?.text).toBe("");
    expect((pages.items[2] as DocumentPage).spec?.text).toContain("arbitration agreement");

    // The second pass adds nothing (ALREADY_EXISTS absorbed row by row).
    await runExtractionSweepOnce(extractionSweepDeps());
    const again = await toolDeps.resources.documentPages.invoke.list(
      create(ListDocumentPagesRequestSchema, { documentId: id, pageSize: 100 }),
      { id: people.lead.userId, kind: "user" },
    );
    expect(Number(again.totalCount)).toBe(3);
  });

  it("an image answers NO_TEXT_LAYER without a parse; garbage bytes answer FAILED — both terminal", async () => {
    const photo = await upload(
      people.lead.email,
      caseAId,
      "site-photo.png",
      "evidence",
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
      "image/png",
    );
    const garbage = await upload(
      people.lead.email,
      caseAId,
      "corrupt.pdf",
      "correspondence",
      "not a pdf at all — a copy-paste accident",
    );

    await runExtractionSweepOnce(extractionSweepDeps());

    expect((await documentById(photo.json.metadata?.id ?? "")).status?.extraction).toBe(
      ExtractionState.NO_TEXT_LAYER,
    );
    expect((await documentById(garbage.json.metadata?.id ?? "")).status?.extraction).toBe(
      ExtractionState.FAILED,
    );
  });

  it("a scan-shaped PDF (parses, no meaningful text) answers NO_TEXT_LAYER, not EXTRACTED", async () => {
    const scan = await upload(
      people.lead.email,
      caseAId,
      "scanned-order.pdf",
      "order_judgment",
      makeTextPdf(["", "x"]), // stray-glyph scan: parses fine, says nothing
    );
    await runExtractionSweepOnce(extractionSweepDeps());
    const swept = await documentById(scan.json.metadata?.id ?? "");
    expect(swept.status?.extraction).toBe(ExtractionState.NO_TEXT_LAYER);
    expect(swept.status?.pageCount).toBe(0);
  });

  it("a broken-ToUnicode PDF (U+0000 glyphs) persists STRIPPED and reaches EXTRACTED — the live poison pill cannot wedge the sweep", async () => {
    // The live shape (2026-08-13): a Chrome print-to-pdf ToUnicode gap
    // yields real U+0000 from pdfjs; Postgres jsonb REJECTS \u0000, the
    // untyped persist error classified as transient, and the document
    // retried every tick forever — documents are immutable, so the
    // poison pill could not even be deleted. This test runs the REAL
    // pipeline into REAL Postgres: without the strip the persist
    // throws and the document never leaves the queue.
    const poisoned = await upload(
      people.lead.email,
      caseAId,
      "chrome-broken-tounicode.pdf",
      "correspondence",
      makeNulGlyphPdf("Notice served on the # tenant demanding vacant possession."),
    );
    const id = poisoned.json.metadata?.id ?? "";
    await runExtractionSweepOnce(extractionSweepDeps());

    const swept = await documentById(id);
    expect(swept.status?.extraction).toBe(ExtractionState.EXTRACTED);
    expect(swept.status?.pageCount).toBe(1);

    const pages = await toolDeps.resources.documentPages.invoke.list(
      create(ListDocumentPagesRequestSchema, { documentId: id, pageSize: 10 }),
      { id: people.lead.userId, kind: "user" },
    );
    const text = (pages.items[0] as DocumentPage).spec?.text ?? "";
    expect(text).not.toContain("\u0000");
    expect(text).toBe("Notice served on the tenant demanding vacant possession.");
  });

  it("page reads are case content: the outsider is refused a document's pages", async () => {
    const pages = await toolDeps.resources.documentPages.invoke.list(
      create(ListDocumentPagesRequestSchema, { documentId: extractedDocId, pageSize: 10 }),
      { id: people.lead.userId, kind: "user" },
    );
    expect(Number(pages.totalCount)).toBeGreaterThan(0);

    await expect(
      toolDeps.resources.documentPages.invoke.list(
        create(ListDocumentPagesRequestSchema, { documentId: extractedDocId, pageSize: 10 }),
        { id: people.outsider.userId, kind: "user" },
      ),
    ).rejects.toThrowError(/case members and partners/);
  });

  it("recordExtraction refuses every person — even the managing partner", async () => {
    await expect(
      toolDeps.resources.documents.invoke.recordExtraction(
        create(RecordDocumentExtractionRequestSchema, {
          id: extractedDocId,
          extraction: ExtractionState.FAILED,
          pageCount: 0,
        }),
        { id: people.partner.userId, kind: "user" },
      ),
    ).rejects.toThrowError(/system-written/);
  });

  /* --------- search_documents + read_document (FR-DOC-004) ----------- */

  it("search_documents finds the passage and cites file number, document, and page", async () => {
    const result = await runTool("search_documents", people.lead.email, {
      query: "barred by limitation",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("barred by limitation under Article 113");
    expect(text).toContain("written-statement.pdf");
    expect(text).toContain("page 1");
    expect(text).toContain(FILE_A);
    expect(text).toMatch(/id doc_/);
  });

  it("search narrows to one matter and relays the denial to a non-member", async () => {
    const scoped = await runTool("search_documents", people.lead.email, {
      query: "limitation",
      file_number: FILE_A,
    });
    expect(textOf(scoped)).toContain("written-statement.pdf");

    const denied = await runTool("search_documents", people.outsider.email, {
      query: "limitation",
      file_number: FILE_A,
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toMatch(/case members and partners/);
  });

  it("a non-member searching the exact phrase firm-wide gets NO snippet — and a partner gets it", async () => {
    // The starvation-proof leakage test: the outsider's search is not
    // denied (they may search their own cases) — it simply cannot see
    // case A's text, even queried verbatim.
    const outsider = await runTool("search_documents", people.outsider.email, {
      query: "barred by limitation under Article 113",
    });
    expect(outsider.isError).toBeFalsy();
    expect(textOf(outsider)).not.toContain("written-statement.pdf");
    expect(textOf(outsider)).toMatch(/No document pages match/);

    const partner = await runTool("search_documents", people.partner.email, {
      query: "barred by limitation under Article 113",
    });
    expect(textOf(partner)).toContain("written-statement.pdf");
  });

  it("searches and windows multilingual pages — store folding + grapheme-safe snippets (#2, #3)", async () => {
    // Multilingual text enters through the SAME system-only create the
    // extraction sweep rides (and the future OCR sweep will — DD-009):
    // the Type1/WinAnsi PDF fixture builder cannot encode complex
    // scripts, and producing them from scans IS the deferred OCR
    // feature. What must hold TODAY, end to end on real Postgres:
    // byte-exact matching for a caseless script, Unicode folding for
    // accented Latin (the adapter's own ICU collation, whatever locale
    // this container booted with), and snippet edges that never orphan
    // a combining mark.
    const uploaded = await upload(
      people.lead.email,
      caseAId,
      "witness-statement-telugu.pdf",
      "evidence",
      "%PDF-1.4 stand-in bytes; the page rows below are the fixture",
    );
    expect(uploaded.status).toBe(201);
    const docId = uploaded.json.metadata?.id ?? "";

    // "మై" clusters flank the match so a ±120 window edge lands inside
    // one — the exact defect shape of issue #2.
    const padding = "మై".repeat(150);
    const sweep = extractionSweepDeps();
    await sweep.createDocumentPage(
      create(DocumentPageSchema, {
        spec: { documentId: docId, caseId: caseAId, page: 1, text: `క${padding} సాక్షి వాంగ్మూలం ${padding}` },
      }),
      SYSTEM_PRINCIPAL,
    );
    await sweep.createDocumentPage(
      create(DocumentPageSchema, {
        spec: { documentId: docId, caseId: caseAId, page: 2, text: "Certified translation of the RÉSUMÉ OF ARGUMENTS follows." },
      }),
      SYSTEM_PRINCIPAL,
    );
    // Close the loop the sweep would have closed — EXTRACTED is the
    // promise the pages exist, and later sweep runs skip this document.
    await sweep.recordExtraction(
      create(RecordDocumentExtractionRequestSchema, {
        id: docId,
        extraction: ExtractionState.EXTRACTED,
        pageCount: 2,
      }),
      SYSTEM_PRINCIPAL,
    );

    // Caseless script: byte-exact hit; the snippet opens on a whole
    // grapheme, never an orphaned matra (issue #2's visible defect).
    const telugu = await runTool("search_documents", people.lead.email, { query: "సాక్షి" });
    expect(telugu.isError).toBeFalsy();
    expect(textOf(telugu)).toContain("witness-statement-telugu.pdf");
    const hit = (telugu.structuredContent as { hits: { snippet: string }[] }).hits[0];
    expect(hit?.snippet).toContain("సాక్షి");
    expect(/^…?\p{M}/u.test(hit?.snippet ?? "")).toBe(false);

    // Accented Latin folds INSIDE the store query (issue #3) — the
    // commons contract suite proves this against a pinned C locale;
    // here it must simply hold through the whole tool chain.
    const folded = await runTool("search_documents", people.lead.email, {
      query: "résumé of arguments",
    });
    expect(textOf(folded)).toContain("witness-statement-telugu.pdf");
    expect(textOf(folded)).toContain("page 2");
  });

  it("read_document returns budgeted whole pages, and a single page on request", async () => {
    const whole = await runTool("read_document", people.lead.email, {
      document_id: extractedDocId,
    });
    expect(whole.isError).toBeFalsy();
    expect(textOf(whole)).toContain("[page 1]");
    expect(textOf(whole)).toContain("arbitration agreement dated 1 June 2024");

    const single = await runTool("read_document", people.lead.email, {
      document_id: extractedDocId,
      page: 3,
    });
    expect(textOf(single)).toContain("page 3 of 3");
    expect(textOf(single)).toContain("arbitration agreement");
    expect(textOf(single)).not.toContain("Article 113"); // page 1 content stays on page 1

    const missing = await runTool("read_document", people.lead.email, {
      document_id: extractedDocId,
      page: 9,
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/page 9 does not exist/);
  });

  it("read_document is honest about scans and refuses the outsider with the policy sentence", async () => {
    const scans = await toolDeps.resources.documents.invoke.list(
      create(ListDocumentsRequestSchema, { caseId: caseAId, pageSize: 100 }),
      { id: people.lead.userId, kind: "user" },
    );
    const scan = (scans.items as Document[]).find(
      (d) => d.spec?.fileName === "scanned-order.pdf",
    );
    const honest = await runTool("read_document", people.lead.email, {
      document_id: scan?.metadata?.id ?? "",
    });
    expect(honest.isError).toBe(true);
    expect(textOf(honest)).toMatch(/scan or photo/);

    const denied = await runTool("read_document", people.outsider.email, {
      document_id: extractedDocId,
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toMatch(/case members and partners/);
  });

  /* -------- attach_document (FR-ASST-002, on the #532 hand-off) ------- */

  const JPEG_FIXTURE = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from("photographed court order, fictional"),
  ]);

  /** Stages a "file someone sent" the way the platform does — an object
   * in a bucket reachable only through a presigned URL. */
  async function stageSentFile(key: string, body: Buffer, contentType: string): Promise<string> {
    await s3.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }),
    );
    return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
      expiresIn: 3600,
    });
  }

  it("files a sent photo onto the matter: fetched by URL, byte-identical, typed by its bytes, extraction-ready", async () => {
    const url = await stageSentFile(
      "attachments/probe/court-order.jpg",
      JPEG_FIXTURE,
      // A lying content type — the sniff must type the document, not the header.
      "application/octet-stream",
    );
    const result = await runTool("attach_document", people.lead.email, {
      file_number: FILE_A,
      download_url: url,
      file_name: "court-order.jpg",
      category: "evidence",
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Filed:");
    expect(textOf(result)).toContain(FILE_A);
    const filedId = (result.structuredContent as { id: string }).id;
    expect(filedId).toMatch(/^doc_/);

    // The record: typed from magic bytes, categorized, sized.
    const filed = await documentById(filedId);
    expect(filed.spec?.mimeType).toBe("image/jpeg");
    expect(Number(filed.spec?.sizeBytes)).toBe(JPEG_FIXTURE.byteLength);

    // The bytes ride the same download route as a web upload.
    const download = await fetch(`${base}/files/documents/${filedId}/content`, {
      headers: auth.as(people.lead.userId).headers,
    });
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).equals(JPEG_FIXTURE)).toBe(true);

    // Listed beside the uploads, and in the extraction lifecycle like
    // them: the next sweep answers the honest image verdict.
    expect(textOf(await runTool("find_documents", people.lead.email, { file_number: FILE_A })))
      .toContain("court-order.jpg");
    await runExtractionSweepOnce(extractionSweepDeps());
    expect((await documentById(filedId)).status?.extraction).toBe(ExtractionState.NO_TEXT_LAYER);
  });

  it("refuses a non-member with the policy sentence — filing is case content", async () => {
    const url = await stageSentFile("attachments/probe/outsider.jpg", JPEG_FIXTURE, "image/jpeg");
    const denied = await runTool("attach_document", people.outsider.email, {
      file_number: FILE_A,
      download_url: url,
      file_name: "outsider.jpg",
      category: "evidence",
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toMatch(/case members and partners/);
  });

  it("refuses office staff BEFORE any fetch — the policy answers, not the network", async () => {
    // A URL that would answer "could not be reached" if fetched: a
    // policy sentence in the answer proves authorization fired first.
    // (Office staff fall at case resolution — they cannot view case
    // content, so they can never reach the fetch; the verb's explicit
    // Document/create pre-check behind it covers any future role whose
    // case visibility and filing rights diverge.)
    const denied = await runTool("attach_document", people.office.email, {
      file_number: FILE_A,
      download_url: "http://127.0.0.1:1/never-fetched.jpg",
      file_name: "never.jpg",
      category: "evidence",
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toMatch(/case members and partners/);
    expect(textOf(denied)).not.toContain("could not be reached");
  });

  it("answers a tampered/expired link with the resend instruction", async () => {
    const url = await stageSentFile("attachments/probe/expired.jpg", JPEG_FIXTURE, "image/jpeg");
    const tampered = url.replace(/(X-Amz-Signature=)[0-9a-f]{8}/, "$100000000");
    const refused = await runTool("attach_document", people.lead.email, {
      file_number: FILE_A,
      download_url: tampered,
      file_name: "expired.jpg",
      category: "evidence",
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("sent again");
  });

  it("refuses bytes that are not a PDF/PNG/JPG, whatever the sender named them", async () => {
    const url = await stageSentFile(
      "attachments/probe/notes.txt",
      Buffer.from("just words, no document magic"),
      "application/pdf",
    );
    const refused = await runTool("attach_document", people.lead.email, {
      file_number: FILE_A,
      download_url: url,
      file_name: "notes.pdf",
      category: "evidence",
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("not a PDF");
  });

  it("names the category vocabulary on a typo instead of misfiling", async () => {
    const url = await stageSentFile("attachments/probe/typo.jpg", JPEG_FIXTURE, "image/jpeg");
    const refused = await runTool("attach_document", people.lead.email, {
      file_number: FILE_A,
      download_url: url,
      file_name: "typo.jpg",
      category: "memo",
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("unknown category");
    expect(textOf(refused)).toContain("vakalatnama");
  });

  it("relays the not-found sentence for an unknown file number", async () => {
    const refused = await runTool("attach_document", people.lead.email, {
      file_number: "CS/2099/999",
      download_url: "https://example.com/never.jpg",
      file_name: "never.jpg",
      category: "evidence",
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/CS\/2099\/999/);
  });
});
