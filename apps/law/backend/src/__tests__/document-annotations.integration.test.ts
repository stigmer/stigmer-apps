/**
 * DocumentAnnotation acceptance (DD-010): the append-only mark resource
 * over the full production path — Connect client → real HTTP server →
 * pipeline → real Postgres (Testcontainers), with the Document row
 * created through the REAL byte route (the pipeline's reference checks
 * must see a real document, not a hand-saved row).
 *
 * The deny matrix's per-row proof lives in
 * domain/authz/__tests__/policy.test.ts; this suite proves the
 * pipeline-step invariants the policy cannot see (membership on the
 * document's case, the denormalized case_id verification, REGION's
 * exactly-one-rect) and the wire contract (ordering, paging, the
 * two-method append-only surface).
 */

import type http from "node:http";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { InProcessEventDispatcher } from "@stigmer/resource-api";
import { runMigrations } from "@stigmer/resource-api/postgres";
import { UserSchema, UserService } from "@stigmer/identity";
import {
  createPgActivationCodeStore,
  createPgCredentialStore,
  createPgRefreshTokenStore,
} from "@stigmer/identity/postgres";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CaseSchema,
  CaseService,
  ClientRole,
  ForumKind,
} from "../gen/stigmer/law/case/v1/case_pb.js";
import {
  CaseMemberSchema,
  CaseMemberService,
  RoleOnCase,
} from "../gen/stigmer/law/casemember/v1/casemember_pb.js";
import { ClientSchema, ClientService } from "../gen/stigmer/law/client/v1/client_pb.js";
import {
  AnnotationKind,
  DocumentAnnotationSchema,
  DocumentAnnotationService,
} from "../gen/stigmer/law/documentannotation/v1/documentannotation_pb.js";
import {
  FirmMemberSchema,
  FirmMemberService,
  FirmRole,
} from "../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import type { AuthorizationEngine } from "@stigmer/authorization";
import { createBackendServer } from "../server.js";
import { createResourceStore } from "../storage.js";
import { memoryObjectStore } from "./memory-object-store.js";
import { makeTextPdf } from "./test-pdf.js";
import { createTestAuth, type TestAuth } from "./test-auth.js";
import { startTestAuthz, type TestAuthz } from "./test-authz.js";
import { testMigrationSources } from "./test-migrations.js";
import { createTestPool } from "./test-pool.js";

async function expectCode(promise: Promise<unknown>, code: Code, pattern?: RegExp) {
  try {
    await promise;
    expect.fail(`expected ConnectError ${Code[code]}, got success`);
  } catch (err) {
    const cerr = ConnectError.from(err);
    expect(cerr.code, `expected ${Code[code]}, got ${Code[cerr.code]}: ${cerr.message}`).toBe(
      code,
    );
    if (pattern) expect(cerr.message).toMatch(pattern);
  }
}

/** A one-line anchor: the shape every test reuses. */
const RECT = { left: 0.1, top: 0.2, width: 0.5, height: 0.03 };

describe("document annotations, end to end", () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let server: http.Server;
  let auth: TestAuth;
  let authz: TestAuthz;
  let engine: AuthorizationEngine;
  let base = "";

  let annotations: Client<typeof DocumentAnnotationService>;

  // lead: the case's lead lawyer. clerk: a case member (the DD-010
  // clerk decision). outsider: an associate on NO case. staff: office.
  const people = {
    lead: { email: "asha@firm.example", role: FirmRole.ASSOCIATE, userId: "", memberId: "" },
    clerk: { email: "kiran@firm.example", role: FirmRole.CLERK, userId: "", memberId: "" },
    outsider: { email: "ravi@firm.example", role: FirmRole.ASSOCIATE, userId: "", memberId: "" },
    staff: { email: "meena@firm.example", role: FirmRole.OFFICE_STAFF, userId: "", memberId: "" },
  };

  let caseId = "";
  let otherCaseId = "";
  let documentId = "";

  beforeAll(async () => {
    [container, auth, authz] = await Promise.all([
      new PostgreSqlContainer("postgres:17-alpine").start(),
      createTestAuth(),
      startTestAuthz(),
    ]);
    pool = createTestPool(container.getConnectionUri());
    await runMigrations(pool, testMigrationSources());
    engine = await authz.newEngine();
    const store = createResourceStore(pool);

    server = createBackendServer({
      store,
      auth: auth.kit,
      authz: engine,
      credentials: createPgCredentialStore(pool),
      refreshTokens: createPgRefreshTokenStore(pool),
      activationCodes: createPgActivationCodeStore(pool),
      objectStore: memoryObjectStore(),
      dispatcher: new InProcessEventDispatcher(),
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const transport = createConnectTransport({ baseUrl: base, httpVersion: "1.1" });

    annotations = createClient(DocumentAnnotationService, transport);
    const users = createClient(UserService, transport);
    const firmMembers = createClient(FirmMemberService, transport);
    const clients = createClient(ClientService, transport);
    const cases = createClient(CaseService, transport);
    const caseMembers = createClient(CaseMemberService, transport);

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

    const client = await clients.create(
      create(ClientSchema, { spec: { displayName: "Meridian Textiles" } }),
      auth.as(people.lead.userId),
    );
    for (const [file, assign] of [
      ["CS/2026/071", (id: string) => (caseId = id)],
      ["CS/2026/072", (id: string) => (otherCaseId = id)],
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
    await caseMembers.create(
      create(CaseMemberSchema, {
        spec: { caseId, memberId: people.clerk.memberId, roleOnCase: RoleOnCase.CLERK },
      }),
      auth.as(people.lead.userId),
    );

    // The document, through the REAL byte route.
    const res = await fetch(`${base}/files/cases/${caseId}/documents`, {
      method: "POST",
      headers: {
        ...auth.as(people.lead.userId).headers,
        "content-type": "application/pdf",
        "x-file-name": encodeURIComponent("written-statement.pdf"),
        "x-document-category": "pleading",
      },
      body: Buffer.from(makeTextPdf(["The suit is barred by limitation.", "Second page."])),
    });
    expect(res.status).toBe(201);
    documentId = ((await res.json()) as { metadata?: { id?: string } }).metadata?.id ?? "";
    expect(documentId).not.toBe("");
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await pool.end();
    await container.stop();
    await authz.stop();
  });

  function highlight(body: string, overrides?: Record<string, unknown>) {
    return create(DocumentAnnotationSchema, {
      spec: {
        documentId,
        caseId,
        page: 1,
        annotationKind: AnnotationKind.HIGHLIGHT,
        rects: [RECT, { ...RECT, top: 0.24 }],
        quotedText: "barred by limitation",
        body,
        ...overrides,
      },
    });
  }

  /* ----------------------------- the trail --------------------------- */

  it("a case member marks a highlight; the envelope carries the author (DD-010)", async () => {
    const mark = await annotations.create(
      highlight("Limitation defence — cite Art. 113"),
      auth.as(people.lead.userId),
    );
    expect(mark.metadata?.id).toMatch(/^ann_/);
    expect(mark.metadata?.createdBy?.id).toBe(people.lead.userId);
    expect(mark.spec?.rects).toHaveLength(2);
  });

  it("a member CLERK marks a region — the DD-010 clerk decision, on the wire", async () => {
    const mark = await annotations.create(
      highlight("Stamp illegible — check with the registry", {
        annotationKind: AnnotationKind.REGION,
        rects: [RECT],
        quotedText: "",
        page: 2,
      }),
      auth.as(people.clerk.userId),
    );
    expect(mark.metadata?.createdBy?.id).toBe(people.clerk.userId);
  });

  it("lists oldest first with a total — the learning trail reads chronologically", async () => {
    const listed = await annotations.list({ documentId }, auth.as(people.clerk.userId));
    expect(listed.totalCount).toBe(2n);
    expect(listed.items.map((a) => a.spec?.body)).toEqual([
      "Limitation defence — cite Art. 113",
      "Stamp illegible — check with the registry",
    ]);
  });

  /* --------------------------- the refusals -------------------------- */

  it("a NON-MEMBER lawyer can neither mark nor read marks — membership is the document's case's rule", async () => {
    await expectCode(
      annotations.create(highlight("outsider"), auth.as(people.outsider.userId)),
      Code.PermissionDenied,
      /case members and partners/,
    );
    await expectCode(
      annotations.list({ documentId }, auth.as(people.outsider.userId)),
      Code.PermissionDenied,
      /case members and partners/,
    );
  });

  it("office staff are refused at the role gate", async () => {
    await expectCode(
      annotations.create(highlight("staff"), auth.as(people.staff.userId)),
      Code.PermissionDenied,
      /Office staff/,
    );
    await expectCode(
      annotations.list({ documentId }, auth.as(people.staff.userId)),
      Code.PermissionDenied,
      /Office staff/,
    );
  });

  it("a lying case_id is refused — denormalized, never trusted", async () => {
    await expectCode(
      annotations.create(
        highlight("misfiled", { caseId: otherCaseId }),
        auth.as(people.lead.userId),
      ),
      Code.InvalidArgument,
      /case_id must match/,
    );
  });

  it("a REGION carries exactly one rect — per-line rects are a highlight's shape", async () => {
    await expectCode(
      annotations.create(
        highlight("two-rect region", {
          annotationKind: AnnotationKind.REGION,
          rects: [RECT, { ...RECT, top: 0.5 }],
        }),
        auth.as(people.lead.userId),
      ),
      Code.InvalidArgument,
      /exactly one rectangle/,
    );
  });

  it("a mark on a missing document is refused by the reference check", async () => {
    await expectCode(
      annotations.create(
        highlight("orphan", { documentId: "doc_missing" }),
        auth.as(people.lead.userId),
      ),
      Code.FailedPrecondition,
      /not found/,
    );
  });

  it("the wire surface is Create + List and NOTHING else — append-only by contract", () => {
    // The proto declares no other method, so the absence is the
    // contract (DD-010): this pins that no update/delete/resolve RPC
    // quietly appears without re-litigating the record model.
    expect(DocumentAnnotationService.methods.map((m) => m.localName).sort()).toEqual([
      "create",
      "list",
    ]);
  });
});
