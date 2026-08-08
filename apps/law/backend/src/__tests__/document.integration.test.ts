/**
 * Document acceptance tests — the byte routes (upload/download over plain
 * HTTP, T03 D6) plus the Get/List Connect surface and the real
 * document_count derivation on Case. Full production path: real HTTP
 * server → pipeline (via the invoker for create) → real Postgres, with
 * bytes in real MinIO through the real S3 client — the exact client
 * configuration shape production uses against R2 (endpoint override,
 * DD-001).
 *
 * Source: design-decisions/001-mvp-scope-contract.md Document row and
 * "cut line"; tasks/T03_0_plan.md D4/D6.
 */

import type http from "node:http";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { runMigrations } from "@stigmer/resource-api/postgres";
import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { createTestPool } from "./test-pool.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CaseSchema, CaseService } from "../gen/stigmer/law/case/v1/case_pb.js";
import { DocumentService } from "../gen/stigmer/law/document/v1/document_pb.js";
import { UserSchema, UserService } from "../gen/stigmer/law/user/v1/user_pb.js";
import { createPgCredentialStore } from "../domain/user/credentials.js";
import { MAX_UPLOAD_BYTES } from "../files/file-routes.js";
import { createS3ObjectStore } from "../objectstore/object-store.js";
import { createBackendServer } from "../server.js";
import { createResourceStore } from "../storage.js";

const MIGRATIONS_DIR = new URL("../../migrations", import.meta.url).pathname;

const asUser = (id: string) => ({ headers: { "x-dev-caller-id": id } });
const asOperator = () => ({
  headers: { "x-dev-caller-id": "ops-one", "x-dev-caller-kind": "operator" },
});

const PDF_BYTES = Buffer.from("%PDF-1.4 fake but honest test bytes");

async function expectCode(promise: Promise<unknown>, code: Code, pattern?: RegExp) {
  try {
    await promise;
    expect.fail(`expected ConnectError ${Code[code]}, got success`);
  } catch (err) {
    const cerr = ConnectError.from(err);
    expect(cerr.code, `expected ${Code[code]}, got ${Code[cerr.code]}: ${cerr.message}`).toBe(code);
    if (pattern) expect(cerr.message).toMatch(pattern);
  }
}

describe("Document resource and byte routes", () => {
  let pgContainer: StartedPostgreSqlContainer;
  let minio: StartedMinioContainer;
  let pool: pg.Pool;
  let server: http.Server;
  let baseUrl = "";
  let transport: Transport;
  let documents: Client<typeof DocumentService>;
  let cases: Client<typeof CaseService>;

  let lawyer = "";
  let caseId = "";
  let otherCaseId = "";

  function upload(options: {
    caseId?: string;
    fileName?: string;
    contentType?: string;
    body?: Buffer;
    caller?: string;
  } = {}) {
    return fetch(`${baseUrl}/files/cases/${options.caseId ?? caseId}/documents`, {
      method: "POST",
      headers: {
        "content-type": options.contentType ?? "application/pdf",
        "x-file-name": encodeURIComponent(options.fileName ?? "vakalatnama.pdf"),
        ...(options.caller === "" ? {} : { "x-dev-caller-id": options.caller ?? lawyer }),
      },
      body: new Uint8Array(options.body ?? PDF_BYTES),
    });
  }

  beforeAll(async () => {
    [pgContainer, minio] = await Promise.all([
      new PostgreSqlContainer("postgres:17-alpine").start(),
      new MinioContainer("minio/minio:RELEASE.2025-07-23T15-54-02Z").start(),
    ]);
    pool = createTestPool(pgContainer.getConnectionUri());
    await runMigrations(pool, MIGRATIONS_DIR);

    const objectStore = createS3ObjectStore({
      endpoint: minio.getConnectionUrl(),
      region: "auto",
      bucket: "law-documents",
      accessKeyId: minio.getUsername(),
      secretAccessKey: minio.getPassword(),
    });
    // The bucket exists in production by provisioning (_ops/planton R2);
    // tests provision it the same way, out of band of the app.
    const { S3Client, CreateBucketCommand } = await import("@aws-sdk/client-s3");
    await new S3Client({
      endpoint: minio.getConnectionUrl(),
      region: "auto",
      credentials: { accessKeyId: minio.getUsername(), secretAccessKey: minio.getPassword() },
      forcePathStyle: true,
    }).send(new CreateBucketCommand({ Bucket: "law-documents" }));

    server = createBackendServer({
      store: createResourceStore(pool),
      credentials: createPgCredentialStore(pool),
      objectStore,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://localhost:${port}`;
    transport = createConnectTransport({ baseUrl, httpVersion: "1.1" });
    documents = createClient(DocumentService, transport);
    cases = createClient(CaseService, transport);

    const users = createClient(UserService, transport);
    lawyer = (
      await users.create(create(UserSchema, { spec: { email: "doc-owner@example.com" } }), asOperator())
    ).metadata?.id as string;

    const makeCase = async (caseNumber: string) =>
      (
        await cases.create(
          create(CaseSchema, {
            spec: { caseNumber, clientName: "Client", caseType: "civil", assignedLawyerId: lawyer },
          }),
          asUser(lawyer),
        )
      ).metadata?.id as string;
    caseId = await makeCase("DOC-1/2026");
    otherCaseId = await makeCase("DOC-2/2026");
  }, 180_000);

  afterEach(async () => {
    await pool.query("DELETE FROM documents");
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await pool.end();
    await Promise.all([pgContainer.stop(), minio.stop()]);
  });

  describe("upload (POST /files/cases/{caseId}/documents)", () => {
    it("stores the bytes, creates the row through the pipeline, and returns the document", async () => {
      const res = await upload({ fileName: "साक्ष्य-affidavit.pdf" });
      expect(res.status).toBe(201);
      const doc = (await res.json()) as {
        metadata: { id: string; version: string; createdBy: { id: string } };
        apiVersion: string;
        spec: { caseId: string; fileName: string; mimeType: string; sizeBytes: string; objectKey: string };
      };
      expect(doc.metadata.id).toMatch(/^doc_[0-9a-z]{26}$/);
      expect(doc.metadata.createdBy.id).toBe(lawyer);
      expect(doc.apiVersion).toBe("law.stigmer.ai/v1");
      // The non-ASCII filename round-trips (headers carry it URI-encoded).
      expect(doc.spec.fileName).toBe("साक्ष्य-affidavit.pdf");
      expect(doc.spec.mimeType).toBe("application/pdf");
      expect(Number(doc.spec.sizeBytes)).toBe(PDF_BYTES.byteLength);
      expect(doc.spec.objectKey).toMatch(new RegExp(`^cases/${caseId}/documents/`));
    });

    it("rejects an unsupported content type (PDF, PNG, JPG only)", async () => {
      const res = await upload({ contentType: "application/zip" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toMatch(/application\/zip/);
    });

    it("rejects an oversize body at the 25 MB contract cap", async () => {
      const res = await upload({ body: Buffer.alloc(MAX_UPLOAD_BYTES + 1) });
      expect(res.status).toBe(413);
    });

    it("requires authentication before accepting a single byte", async () => {
      const res = await upload({ caller: "" });
      expect(res.status).toBe(401);
    });

    it("answers 412 for a case that does not exist and leaves no orphan row", async () => {
      const res = await upload({ caseId: "case_ghost" });
      expect(res.status).toBe(412);
      expect(((await res.json()) as { message: string }).message).toMatch(/case 'case_ghost' not found/);
      const rows = await pool.query("SELECT count(*)::int AS n FROM documents");
      expect(rows.rows[0].n).toBe(0);
    });

    it("requires a filename", async () => {
      const res = await fetch(`${baseUrl}/files/cases/${caseId}/documents`, {
        method: "POST",
        headers: { "content-type": "application/pdf", "x-dev-caller-id": lawyer },
        body: new Uint8Array(PDF_BYTES),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toMatch(/x-file-name/);
    });
  });

  describe("download (GET /files/documents/{id}/content)", () => {
    it("streams the exact bytes back with the right type and download name", async () => {
      const uploaded = (await (await upload({ fileName: "evidence.pdf" })).json()) as {
        metadata: { id: string };
      };

      const res = await fetch(`${baseUrl}/files/documents/${uploaded.metadata.id}/content`, {
        headers: { "x-dev-caller-id": lawyer },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("content-disposition")).toContain("attachment");
      expect(res.headers.get("content-disposition")).toContain(
        encodeURIComponent("evidence.pdf"),
      );
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.equals(PDF_BYTES)).toBe(true);
    });

    it("answers 404 for an unknown document and 401 unauthenticated", async () => {
      const missing = await fetch(`${baseUrl}/files/documents/doc_ghost/content`, {
        headers: { "x-dev-caller-id": lawyer },
      });
      expect(missing.status).toBe(404);

      const anon = await fetch(`${baseUrl}/files/documents/doc_ghost/content`);
      expect(anon.status).toBe(401);
    });
  });

  describe("get/list over Connect (metadata only)", () => {
    it("gets by id and lists a case's documents newest first", async () => {
      const first = (await (await upload({ fileName: "one.pdf" })).json()) as {
        metadata: { id: string };
      };
      await upload({ fileName: "two.pdf" });
      await upload({ fileName: "elsewhere.pdf", caseId: otherCaseId });

      const got = await documents.get({ id: first.metadata.id }, asUser(lawyer));
      expect(got.spec?.fileName).toBe("one.pdf");

      const list = await documents.list({ caseId }, asUser(lawyer));
      expect(list.items.map((d) => d.spec?.fileName)).toEqual(["two.pdf", "one.pdf"]);
      expect(list.totalCount).toBe(2n);
    });

    it("declares exactly get/list — bytes are never a Connect concern", () => {
      expect(DocumentService.methods.map((m) => m.localName).sort()).toEqual(["get", "list"]);
    });
  });

  describe("Case.document_count becomes real (FR-CASE-005 AC8; D4)", () => {
    it("derives the count per case on get AND across a list page in one grouped query", async () => {
      await upload({ fileName: "a.pdf" });
      await upload({ fileName: "b.pdf" });
      await upload({ fileName: "c.pdf", caseId: otherCaseId });

      const one = await cases.get({ id: caseId }, asUser(lawyer));
      expect(one.status?.documentCount).toBe(2);

      const page = await cases.list({}, asUser(lawyer));
      const byNumber = new Map(page.items.map((c) => [c.spec?.caseNumber, c.status?.documentCount]));
      expect(byNumber.get("DOC-1/2026")).toBe(2);
      expect(byNumber.get("DOC-2/2026")).toBe(1);
    });
  });

  describe("uniform error contract on the Connect surface", () => {
    it("answers NOT_FOUND naming the reference and UNAUTHENTICATED without identity", async () => {
      await expectCode(
        documents.get({ id: "doc_ghost" }, asUser(lawyer)),
        Code.NotFound,
        /Document 'doc_ghost' not found/,
      );
      await expectCode(documents.list({ caseId }), Code.Unauthenticated);
    });
  });
});
