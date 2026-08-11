/**
 * The rebuild's acceptance arc, derived from the adopted scope contract
 * (design-decisions/002-scope-contract.md) — every test names its FR.
 * Full production path: Connect client → real HTTP server → pipeline →
 * real Postgres (Testcontainers). One firm, seeded once, exercised in
 * contract order: intake → conflict check → the hearing cycle → the
 * matrix's wire-level denials → money → deadlines and the sweep → the
 * audit trail → offboarding.
 *
 * The DENY matrix's exhaustive per-row proof lives in
 * domain/authz/__tests__/policy.test.ts; this suite re-proves the hot
 * boundaries end to end so no wiring gap can quietly reopen them.
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
import { AuditEntryService } from "../gen/stigmer/law/auditentry/v1/auditentry_pb.js";
import { ClientSchema, ClientService } from "../gen/stigmer/law/client/v1/client_pb.js";
import {
  DeadlineSchema,
  DeadlineService,
} from "../gen/stigmer/law/deadline/v1/deadline_pb.js";
import {
  FeeArrangementSchema,
  FeeArrangementService,
  FeeKind,
} from "../gen/stigmer/law/feearrangement/v1/feearrangement_pb.js";
import {
  FirmMemberSchema,
  FirmMemberService,
  FirmRole,
} from "../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import {
  HearingSchema,
  HearingService,
  OutcomeKind,
} from "../gen/stigmer/law/hearing/v1/hearing_pb.js";
import {
  LedgerEntryKind,
  LedgerEntrySchema,
  LedgerEntryService,
} from "../gen/stigmer/law/ledgerentry/v1/ledgerentry_pb.js";
import { NotificationService } from "../gen/stigmer/law/notification/v1/notification_pb.js";
import { addDaysToIsoDate, todayInFirmTimezone } from "../domain/firm-clock.js";
import { runSweepOnce } from "../domain/reminders/sweep.js";
import type { AuthorizationEngine } from "@stigmer/authorization";
import { createApp } from "../routes.js";
import { createBackendServer } from "../server.js";
import { createResourceStore } from "../storage.js";
import { memoryObjectStore } from "./memory-object-store.js";
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

describe("the rebuilt firm, end to end", () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let server: http.Server;
  let auth: TestAuth;
  let authz: TestAuthz;
  let engine: AuthorizationEngine;
  let store: ReturnType<typeof createResourceStore>;

  // Service clients (created once the port is known).
  let clients: Client<typeof ClientService>;
  let cases: Client<typeof CaseService>;
  let caseMembers: Client<typeof CaseMemberService>;
  let hearings: Client<typeof HearingService>;
  let deadlines: Client<typeof DeadlineService>;
  let fees: Client<typeof FeeArrangementService>;
  let ledger: Client<typeof LedgerEntryService>;
  let notifications: Client<typeof NotificationService>;
  let audit: Client<typeof AuditEntryService>;
  let firmMembers: Client<typeof FirmMemberService>;

  // The firm: user ids (tokens) and FirmMember ids (person references).
  const people = {
    mp: { email: "meera@firm.example", role: FirmRole.MANAGING_PARTNER, userId: "", memberId: "" },
    associate: { email: "arjun@firm.example", role: FirmRole.ASSOCIATE, userId: "", memberId: "" },
    associate2: { email: "divya@firm.example", role: FirmRole.ASSOCIATE, userId: "", memberId: "" },
    clerk: { email: "kiran@firm.example", role: FirmRole.CLERK, userId: "", memberId: "" },
    staff: { email: "meena@firm.example", role: FirmRole.OFFICE_STAFF, userId: "", memberId: "" },
  };

  // Built by the arc, read by later tests.
  let clientId = "";
  let caseId = "";
  const FILE_NUMBER = "CS/2026/042";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    pool = createTestPool(container.getConnectionUri());
    await runMigrations(pool, testMigrationSources());
    auth = await createTestAuth();
    authz = await startTestAuthz();
    engine = await authz.newEngine();
    store = createResourceStore(pool);

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
    const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    const transport = createConnectTransport({ baseUrl, httpVersion: "1.1" });

    clients = createClient(ClientService, transport);
    cases = createClient(CaseService, transport);
    caseMembers = createClient(CaseMemberService, transport);
    hearings = createClient(HearingService, transport);
    deadlines = createClient(DeadlineService, transport);
    fees = createClient(FeeArrangementService, transport);
    ledger = createClient(LedgerEntryService, transport);
    notifications = createClient(NotificationService, transport);
    audit = createClient(AuditEntryService, transport);
    firmMembers = createClient(FirmMemberService, transport);

    // Seed the firm through the operator path (FR-AUTH-002): a User is
    // not staff until a FirmMember profile exists (fail-closed).
    const users = createClient(UserService, transport);
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
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await pool.end();
    await container.stop();
    await authz.stop();
  });

  /* ------------------------- intake (J4) ---------------------------- */

  it("FR-CLIENT-001/FR-CASE-001: an associate opens a client and a matter at intake", async () => {
    const client = await clients.create(
      create(ClientSchema, {
        spec: { displayName: "Meridian Textiles", notes: "fictional acceptance client" },
      }),
      auth.as(people.associate.userId),
    );
    clientId = client.metadata?.id ?? "";

    const matter = await cases.create(
      create(CaseSchema, {
        spec: {
          fileNumber: FILE_NUMBER,
          clientId,
          clientRole: ClientRole.PLAINTIFF,
          opposingParties: [{ name: "Sunrise Traders", counselName: "Sri Rao" }],
          forum: { forumKind: ForumKind.DISTRICT_COURT, name: "III Addl District Court" },
          caseType: "civil",
          leadLawyerId: people.associate.memberId,
        },
      }),
      auth.as(people.associate.userId),
    );
    caseId = matter.metadata?.id ?? "";
    expect(matter.spec?.fileNumber).toBe(FILE_NUMBER);
    // No hearings yet: the stored-derived fact starts absent (Q6).
    expect(matter.status?.nextHearingDate).toBeUndefined();
  });

  it("FR-CASE-001: a duplicate file number answers ALREADY_EXISTS naming the value", async () => {
    await expectCode(
      cases.create(
        create(CaseSchema, {
          spec: {
            fileNumber: FILE_NUMBER,
            clientId,
            clientRole: ClientRole.PLAINTIFF,
            forum: { forumKind: ForumKind.DISTRICT_COURT, name: "III Addl District Court" },
            caseType: "civil",
            leadLawyerId: people.associate.memberId,
          },
        }),
        auth.as(people.associate.userId),
      ),
      Code.AlreadyExists,
      new RegExp(FILE_NUMBER.replace(/[/]/g, "\\/")),
    );
  });

  it("the lead lawyer is materialized as an active case member (Gate-1)", async () => {
    const members = await caseMembers.list({ caseId }, auth.as(people.associate.userId));
    expect(members.items.map((m) => m.spec?.memberId)).toContain(people.associate.memberId);
  });

  it("FR-CASE-003: the lead adds the clerk to the matter; re-adding answers ALREADY_EXISTS", async () => {
    await caseMembers.create(
      create(CaseMemberSchema, {
        spec: { caseId, memberId: people.clerk.memberId, roleOnCase: RoleOnCase.CLERK },
      }),
      auth.as(people.associate.userId),
    );
    await expectCode(
      caseMembers.create(
        create(CaseMemberSchema, {
          spec: { caseId, memberId: people.clerk.memberId, roleOnCase: RoleOnCase.CLERK },
        }),
        auth.as(people.associate.userId),
      ),
      Code.AlreadyExists,
      /membership/,
    );
  });

  /* ------------------- the conflict check (FR-CLIENT-003) ----------- */

  it("FR-CLIENT-003: one search answers client names AND opposing-party names, case-insensitively", async () => {
    const result = await clients.search({ query: "meridian" }, auth.as(people.mp.userId));
    expect(result.clients.map((c) => c.spec?.displayName)).toContain("Meridian Textiles");

    const opposing = await clients.search({ query: "SUNRISE" }, auth.as(people.mp.userId));
    expect(opposing.opposingPartyHits.map((h) => h.fileNumber)).toContain(FILE_NUMBER);
    expect(opposing.opposingPartyHits[0]?.matchedPartyName).toBe("Sunrise Traders");
  });

  /* ----------------- the hearing cycle (J3, FR-HEAR-*) -------------- */

  let firstHearingId = "";

  it("FR-HEAR-001 + Q6: the clerk schedules a hearing and the case's next date follows", async () => {
    const date = addDaysToIsoDate(todayInFirmTimezone(), 3);
    const hearing = await hearings.create(
      create(HearingSchema, {
        spec: { caseId, date, purpose: "filing of written statement" },
      }),
      auth.as(people.clerk.userId),
    );
    firstHearingId = hearing.metadata?.id ?? "";

    const matter = await cases.get({ id: caseId }, auth.as(people.associate.userId));
    expect(matter.status?.nextHearingDate).toBe(date);
  });

  it("FR-HEAR-006: the clerk records the cause-list serial and hall while scheduled", async () => {
    const loaded = await hearings.get({ id: firstHearingId }, auth.as(people.clerk.userId));
    loaded.spec!.listSerialNumber = "47";
    loaded.spec!.courtHall = "3";
    const updated = await hearings.update(loaded, auth.as(people.clerk.userId));
    expect(updated.spec?.listSerialNumber).toBe("47");
  });

  it("FR-HEAR-002: recording an outcome with a next date schedules the next hearing in the same call", async () => {
    const nextDate = addDaysToIsoDate(todayInFirmTimezone(), 21);
    const result = await hearings.recordOutcome(
      {
        id: firstHearingId,
        outcomeKind: OutcomeKind.ADJOURNED,
        outcomeNotes: "defense sought time",
        attendedBy: [people.clerk.memberId],
        nextDate,
        nextPurpose: "evidence",
      },
      auth.as(people.clerk.userId),
    );
    expect(result.hearing?.status?.outcomeKind).toBe(OutcomeKind.ADJOURNED);
    expect(result.nextHearing?.spec?.date).toBe(nextDate);

    // The stored-derived fact refreshed through the event → recompute
    // chain (Q6) — the diary drives the case row, never the reverse.
    const matter = await cases.get({ id: caseId }, auth.as(people.associate.userId));
    expect(matter.status?.nextHearingDate).toBe(nextDate);
  });

  it("FR-HEAR-002: a recorded outcome is immutable — recording again refuses with the recovery path", async () => {
    await expectCode(
      hearings.recordOutcome(
        { id: firstHearingId, outcomeKind: OutcomeKind.HEARD },
        auth.as(people.clerk.userId),
      ),
      Code.FailedPrecondition,
      /already recorded/,
    );
  });

  it("FR-HEAR-006: listing details freeze with the outcome", async () => {
    const completed = await hearings.get({ id: firstHearingId }, auth.as(people.clerk.userId));
    completed.spec!.courtHall = "5";
    await expectCode(
      hearings.update(completed, auth.as(people.clerk.userId)),
      Code.FailedPrecondition,
      /frozen/,
    );
  });

  /* ------------- the matrix at the wire (FR-AUTHZ-*) ---------------- */

  it("FR-AUTHZ-002/003: a non-member associate gets the list line but never the content", async () => {
    const summaries = await cases.list({}, auth.as(people.associate2.userId));
    expect(summaries.items.map((s) => s.fileNumber)).toContain(FILE_NUMBER);
    await expectCode(
      cases.get({ id: caseId }, auth.as(people.associate2.userId)),
      Code.PermissionDenied,
      /case members and partners/,
    );
  });

  it("FR-AUTHZ-002: office staff see no case lists at all", async () => {
    await expectCode(
      cases.list({}, auth.as(people.staff.userId)),
      Code.PermissionDenied,
      /office staff/i,
    );
  });

  it("FR-MEMBER-001: a user with NO firm profile is denied everything", async () => {
    const users = createClient(
      UserService,
      createConnectTransport({
        baseUrl: `http://localhost:${(server.address() as AddressInfo).port}`,
        httpVersion: "1.1",
      }),
    );
    const outsider = await users.create(
      create(UserSchema, { spec: { email: "outsider@firm.example" } }),
      auth.asOperator(),
    );
    await auth.mint(outsider.metadata?.id ?? "");
    await expectCode(
      cases.list({}, auth.as(outsider.metadata?.id ?? "")),
      Code.PermissionDenied,
      /No active firm membership/,
    );
  });

  /* --------------------- money (J5, FR-MONEY-*) --------------------- */

  it("FR-MONEY-001 + FR-AUTHZ-004: partners set the arrangement; the case's own lead cannot even read it", async () => {
    await fees.create(
      create(FeeArrangementSchema, {
        spec: { caseId, feeKind: FeeKind.LUMP_SUM, lumpSumPaise: 15000000n },
      }),
      auth.as(people.mp.userId),
    );
    await expectCode(
      fees.get({ caseId }, auth.as(people.associate.userId)),
      Code.PermissionDenied,
      /partners only/,
    );
  });

  it("FR-MONEY-001: the amount fields must match the fee kind", async () => {
    await expectCode(
      fees.update(
        create(FeeArrangementSchema, {
          spec: {
            caseId,
            feeKind: FeeKind.LUMP_SUM,
            lumpSumPaise: 15000000n,
            monthlyRetainerPaise: 100000n,
          },
        }),
        auth.as(people.mp.userId),
      ),
      Code.InvalidArgument,
      /must match the fee kind/,
    );
  });

  it("FR-MONEY-002/003: the ledger sums to the outstanding, exactly", async () => {
    const entry = (kind: LedgerEntryKind, amountPaise: bigint, note: string) =>
      create(LedgerEntrySchema, {
        spec: { caseId, entryKind: kind, amountPaise, date: todayInFirmTimezone(), note },
      });
    await ledger.create(entry(LedgerEntryKind.CHARGE, 15000000n, "lump sum due"), auth.as(people.mp.userId));
    await ledger.create(entry(LedgerEntryKind.EXPENSE, 250000n, "court fees"), auth.as(people.mp.userId));
    // Office staff record the receipt — blind data entry (FR-AUTHZ-004).
    await ledger.create(entry(LedgerEntryKind.RECEIPT, 5000000n, "advance by UPI"), auth.as(people.staff.userId));

    const outstanding = await ledger.listOutstanding({}, auth.as(people.mp.userId));
    const line = outstanding.items.find((i) => i.caseId === caseId);
    expect(line?.outstandingPaise).toBe(15000000n + 250000n - 5000000n);
  });

  it("FR-AUTHZ-004: office staff may record receipts ONLY, and never read balances", async () => {
    await expectCode(
      ledger.create(
        create(LedgerEntrySchema, {
          spec: {
            caseId,
            entryKind: LedgerEntryKind.CHARGE,
            amountPaise: 100n,
            date: todayInFirmTimezone(),
            note: "should be refused",
          },
        }),
        auth.as(people.staff.userId),
      ),
      Code.PermissionDenied,
      /receipts only/,
    );
    await expectCode(
      ledger.listOutstanding({}, auth.as(people.staff.userId)),
      Code.PermissionDenied,
      /partners only/,
    );
  });

  /* ------------- deadlines and the sweep (FR-DEAD-*, Q4) ------------ */

  it("FR-DEAD-001: the clerk cannot enter deadlines; the lead can", async () => {
    await expectCode(
      deadlines.create(
        create(DeadlineSchema, {
          spec: {
            caseId,
            title: "File written statement",
            dueDate: addDaysToIsoDate(todayInFirmTimezone(), 1),
            statutoryBasis: "O.VIII R.1",
            ownerId: people.clerk.memberId,
          },
        }),
        auth.as(people.clerk.userId),
      ),
      Code.PermissionDenied,
      /lawyers/i,
    );
    await deadlines.create(
      create(DeadlineSchema, {
        spec: {
          caseId,
          title: "File written statement",
          dueDate: addDaysToIsoDate(todayInFirmTimezone(), 1),
          statutoryBasis: "O.VIII R.1 — 30 days from summons",
          ownerId: people.associate.memberId,
        },
      }),
      auth.as(people.associate.userId),
    );
  });

  it("FR-DEAD-002 + FR-HEAR-005: the sweep notifies once, and only once (dedup by construction)", async () => {
    // A hearing whose date passed with no outcome — the nag's subject.
    // Backfilled directly through the wire (FR-HEAR-001 allows past
    // dates exactly for this).
    await hearings.create(
      create(HearingSchema, {
        spec: { caseId, date: addDaysToIsoDate(todayInFirmTimezone(), -2), purpose: "backfilled" },
      }),
      auth.as(people.clerk.userId),
    );

    // The sweep composes its own app over the same store — the exact
    // production assembly of runSweepOnce's dependencies.
    const sweepApp = createApp({
      store,
      caller: auth.kit.resolver.fromConnect,
      authz: engine,
      credentials: createPgCredentialStore(pool),
      refreshTokens: createPgRefreshTokenStore(pool),
      activationCodes: createPgActivationCodeStore(pool),
    });
    const deps = {
      store,
      createNotification: sweepApp.resources.notifications.invoke.create!,
    };
    await runSweepOnce(deps);
    await runSweepOnce(deps); // idempotency: the second pass adds nothing

    const inbox = await notifications.list({ pageSize: 50 }, auth.as(people.associate.userId));
    const bodies = inbox.items.map((n) => `${n.spec?.type}:${n.spec?.dedupKey}`);
    const deadlineNudges = bodies.filter((b) => b.includes("deadline:"));
    const nags = bodies.filter((b) => b.includes("unrecorded_outcome:"));
    expect(deadlineNudges.length).toBe(1); // T-1 window, once
    expect(nags.length).toBe(1); // the backfilled hearing, once
  });

  /* ------------------- the audit trail (FR-AUDIT-001) --------------- */

  it("FR-AUDIT-001: partners read the case's change history; members do not", async () => {
    const history = await audit.list({ caseId, pageSize: 100 }, auth.as(people.mp.userId));
    const kinds = history.items.map((e) => `${e.spec?.subjectKind}:${e.spec?.changeType}`);
    expect(kinds).toContain("Case:1"); // CREATED
    expect(kinds).toContain("Hearing:2"); // UPDATED (the recorded outcome)
    expect(kinds).toContain("LedgerEntry:1");

    const outcomeEntry = history.items.find(
      (e) => e.spec?.subjectKind === "Hearing" && e.spec?.changeType === 2,
    );
    expect(outcomeEntry?.spec?.changes.map((c) => c.fieldPath)).toContain("status.outcomeKind");

    await expectCode(
      audit.list({ caseId }, auth.as(people.associate.userId)),
      Code.PermissionDenied,
      /partners only/,
    );
  });

  /* -------------------- offboarding (FR-MEMBER-002) ----------------- */

  it("FR-MEMBER-002: deactivation locks the member out on their next request", async () => {
    const profile = await firmMembers.get(
      { userId: people.associate2.userId },
      auth.as(people.mp.userId),
    );
    profile.spec!.active = false;
    await firmMembers.update(profile, auth.asOperator());

    await expectCode(
      cases.list({}, auth.as(people.associate2.userId)),
      Code.PermissionDenied,
      /No active firm membership/,
    );
  });
});
