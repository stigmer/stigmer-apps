/**
 * The deny matrix (FR-AUTHZ-005): every role boundary in DD-001's
 * who-sees-what table pinned by a test that proves the DENIAL, not just
 * the allow. Written FROM THE TABLE, not from the policy implementation
 * — if the module and the table disagree, this suite is the table's
 * vote.
 *
 * Runs on the memory store (same port contract as Postgres, enforced by
 * the shared contract suite) against a REAL OpenFGA engine — since
 * DD-003 the policy's relationship answers come from the engine, so a
 * mocked one would make this suite prove nothing (the parity oracle
 * must exercise the real model). Each test gets its own store on one
 * shared container; tuples are reconciled from the seeded rows through
 * the SAME projection production boots with.
 *
 * The FR-cited acceptance tests re-prove the hot boundaries over real
 * HTTP + Postgres per resource slice.
 */

import { create } from "@bufbuild/protobuf";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ActorSchema,
  MemoryResourceStore,
  ResourceMetadataSchema,
  SYSTEM_PRINCIPAL,
  type CallerPrincipal,
} from "@stigmer/resource-api";
import { CaseSchema, type Case } from "../../../gen/stigmer/law/case/v1/case_pb.js";
import {
  CaseMemberSchema,
  RoleOnCase,
  type CaseMember,
} from "../../../gen/stigmer/law/casemember/v1/casemember_pb.js";
import {
  FirmMemberSchema,
  FirmRole,
  type FirmMember,
} from "../../../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import { LedgerEntryKind } from "../../../gen/stigmer/law/ledgerentry/v1/ledgerentry_pb.js";
import {
  NotificationSchema,
  NotificationType,
} from "../../../gen/stigmer/law/notification/v1/notification_pb.js";
import { TaskSchema } from "../../../gen/stigmer/law/task/v1/task_pb.js";
import { reconcileTuples } from "@stigmer/authorization";
import { startTestAuthz, type TestAuthz } from "../../../__tests__/test-authz.js";
import { createFirmPolicy, type FirmPolicy } from "../policy.js";
import { projectAuthorizationTuples } from "../tuples.js";

/* ------------------------------ fixtures ---------------------------- */

function meta(id: string) {
  return create(ResourceMetadataSchema, {
    id,
    version: 1n,
    createdBy: create(ActorSchema, { id: "seed" }),
    updatedBy: create(ActorSchema, { id: "seed" }),
  });
}

function firmMember(id: string, userId: string, role: FirmRole, active = true): FirmMember {
  return create(FirmMemberSchema, {
    metadata: meta(id),
    spec: { userId, role, active },
  });
}

function caseMember(caseId: string, memberId: string, active: boolean): CaseMember {
  return create(CaseMemberSchema, {
    metadata: meta(`cmem_${caseId}_${memberId}`),
    spec: { caseId, memberId, roleOnCase: RoleOnCase.LAWYER },
    status: { active },
  });
}

function lawCase(id: string, leadLawyerId: string): Case {
  return create(CaseSchema, {
    metadata: meta(id),
    spec: {
      fileNumber: `FN-${id}`,
      clientId: "client_1",
      leadLawyerId,
      caseType: "civil",
      forum: { name: "III Addl District Court" },
    },
  });
}

// Callers: principal id is the USER id; spec person refs are FirmMember ids.
const callers = {
  mp: { id: "usr_mp", kind: "user" } as CallerPrincipal,
  partner: { id: "usr_partner", kind: "user" } as CallerPrincipal,
  associate: { id: "usr_assoc", kind: "user" } as CallerPrincipal,
  junior: { id: "usr_junior", kind: "user" } as CallerPrincipal,
  clerk: { id: "usr_clerk", kind: "user" } as CallerPrincipal,
  staff: { id: "usr_staff", kind: "user" } as CallerPrincipal,
  exAssociate: { id: "usr_gone", kind: "user" } as CallerPrincipal,
  stranger: { id: "usr_stranger", kind: "user" } as CallerPrincipal,
  operator: { id: "operator", kind: "operator" } as CallerPrincipal,
};

let firm: FirmPolicy;
let store: MemoryResourceStore;
let authz: TestAuthz;

beforeAll(async () => {
  authz = await startTestAuthz();
}, 120_000);

afterAll(async () => {
  await authz.stop();
});

beforeEach(async () => {
  store = new MemoryResourceStore({
    // createdAt is registered where the tuple projection pages
    // (projectAuthorizationTuples orders every listing by it).
    FirmMember: {
      schema: FirmMemberSchema,
      naturalKeyField: "userId",
      fields: { createdAt: "metadata.createdAt" },
    },
    CaseMember: {
      schema: CaseMemberSchema,
      // The composed key, exactly as the Postgres generated column
      // builds it: ACTIVE periods only (removed rows carry no key).
      naturalKeyOf: (r) => {
        const membership = r as CaseMember;
        return membership.status?.active === true && membership.spec
          ? `${membership.spec.caseId}:${membership.spec.memberId}`
          : undefined;
      },
      fields: {
        memberId: "spec.memberId",
        active: "status.active",
        createdAt: "metadata.createdAt",
      },
    },
    Case: {
      schema: CaseSchema,
      naturalKeyField: "fileNumber",
      fields: { createdAt: "metadata.createdAt" },
    },
    Task: { schema: TaskSchema },
  });

  await store.save("FirmMember", firmMember("fmem_mp", "usr_mp", FirmRole.MANAGING_PARTNER));
  await store.save("FirmMember", firmMember("fmem_partner", "usr_partner", FirmRole.PARTNER));
  await store.save("FirmMember", firmMember("fmem_assoc", "usr_assoc", FirmRole.ASSOCIATE));
  await store.save("FirmMember", firmMember("fmem_junior", "usr_junior", FirmRole.JUNIOR));
  await store.save("FirmMember", firmMember("fmem_clerk", "usr_clerk", FirmRole.CLERK));
  await store.save("FirmMember", firmMember("fmem_staff", "usr_staff", FirmRole.OFFICE_STAFF));
  await store.save(
    "FirmMember",
    firmMember("fmem_gone", "usr_gone", FirmRole.ASSOCIATE, false),
  );

  // Case A: lead is the associate; the clerk works it. Case B: lead is
  // the partner; the junior WAS on it (membership removed).
  await store.save("Case", lawCase("case_a", "fmem_assoc"));
  await store.save("Case", lawCase("case_b", "fmem_partner"));
  await store.save("CaseMember", caseMember("case_a", "fmem_assoc", true));
  await store.save("CaseMember", caseMember("case_a", "fmem_clerk", true));
  await store.save("CaseMember", caseMember("case_b", "fmem_junior", false));

  // Rows → tuples through the SAME projection production reconciles
  // with; a fresh store per test keeps tuple state isolated.
  const engine = await authz.newEngine();
  await reconcileTuples(engine, await projectAuthorizationTuples(store));

  firm = createFirmPolicy(store, engine);
});

async function decide(
  caller: CallerPrincipal | undefined,
  kind: string,
  operation: string,
  resource?: unknown,
) {
  return firm.policy.authorize({ caller, kind, operation, resource: resource as never });
}

function expectDeny(decision: { allow: boolean; reason?: string }, why: RegExp) {
  expect(decision.allow).toBe(false);
  expect(decision.reason).toMatch(why);
}

/* ------------------------------- tests ------------------------------ */

describe("gatekeeping (FR-AUTHZ-001: deny by default)", () => {
  it("denies an unauthenticated caller", async () => {
    expectDeny(await decide(undefined, "Case", "list"), /Authentication required/);
  });

  it("denies an authenticated user with NO firm profile", async () => {
    expectDeny(await decide(callers.stranger, "Case", "list"), /No active firm membership/);
  });

  it("denies a DEACTIVATED member everywhere — even reads (FR-MEMBER-002)", async () => {
    expectDeny(await decide(callers.exAssociate, "Case", "list"), /No active firm membership/);
    expectDeny(
      await decide(callers.exAssociate, "Task", "get", { spec: { caseId: "case_a" } }),
      /No active firm membership/,
    );
  });

  it("denies unknown kinds and operations rather than allowing them", async () => {
    expectDeny(await decide(callers.mp, "Mystery", "create"), /not permitted/);
    expectDeny(await decide(callers.mp, "Case", "delete"), /not permitted/);
  });
});

describe("case content (FR-AUTHZ-002/003)", () => {
  it("gives a NON-MEMBER lawyer no case content — get is denied (the list line is all they have)", async () => {
    const caseB = await store.getById("Case", "case_b");
    expectDeny(await decide(callers.associate, "Case", "get", caseB), /case members and partners/);
  });

  it("a REMOVED membership grants nothing", async () => {
    const caseB = await store.getById("Case", "case_b");
    expectDeny(await decide(callers.junior, "Case", "get", caseB), /case members and partners/);
  });

  it("an active member and any partner read case content", async () => {
    const caseA = await store.getById("Case", "case_a");
    expect((await decide(callers.associate, "Case", "get", caseA)).allow).toBe(true);
    expect((await decide(callers.clerk, "Case", "get", caseA)).allow).toBe(true);
    expect((await decide(callers.mp, "Case", "get", caseA)).allow).toBe(true);
  });

  it("office staff see NO cases: list denied, get denied even with membership shapes", async () => {
    expectDeny(await decide(callers.staff, "Case", "list"), /office staff/);
    const caseA = await store.getById("Case", "case_a");
    expectDeny(await decide(callers.staff, "Case", "get", caseA), /case members and partners/);
  });

  it("hearings/notes/documents/tasks: non-members are denied on the loaded resource", async () => {
    for (const kind of ["Hearing", "CaseNote", "Document", "Task"]) {
      expectDeny(
        await decide(callers.junior, kind, "get", { spec: { caseId: "case_a" } }),
        /case members and partners/,
      );
    }
  });

  it("a TaskComment reaches its case THROUGH the task — non-members denied", async () => {
    await store.save(
      "Task",
      create(TaskSchema, { metadata: meta("task_1"), spec: { caseId: "case_a", title: "t" } }),
    );
    const comment = { spec: { taskId: "task_1" } };
    expectDeny(await decide(callers.junior, "TaskComment", "get", comment), /case members/);
    expect((await decide(callers.associate, "TaskComment", "get", comment)).allow).toBe(true);
  });
});

describe("document intelligence (FR-DOC-003/004)", () => {
  it("a document's pages are its case's content: non-members denied on the loaded page", async () => {
    const page = { spec: { caseId: "case_a", documentId: "doc_x", page: 1 } };
    expectDeny(await decide(callers.junior, "DocumentPage", "get", page), /case members and partners/);
    expect((await decide(callers.associate, "DocumentPage", "get", page)).allow).toBe(true);
  });

  it("office staff neither list nor search document text", async () => {
    expectDeny(await decide(callers.staff, "DocumentPage", "list"), /Office staff/);
    expectDeny(await decide(callers.staff, "DocumentPage", "search"), /Office staff/);
    // Case workers pass the role gate; the handlers' guards scope the rest.
    expect((await decide(callers.clerk, "DocumentPage", "search")).allow).toBe(true);
  });

  it("a document's marks are its case's content: non-members denied on the loaded annotation (DD-010)", async () => {
    const mark = { spec: { caseId: "case_a", documentId: "doc_x", page: 1 } };
    expectDeny(
      await decide(callers.junior, "DocumentAnnotation", "get", mark),
      /case members and partners/,
    );
    expect((await decide(callers.associate, "DocumentAnnotation", "get", mark)).allow).toBe(true);
  });

  it("office staff neither create nor list document marks; a case-worker clerk MAY create (DD-010, decided 2026-08-15)", async () => {
    expectDeny(await decide(callers.staff, "DocumentAnnotation", "create"), /Office staff/);
    expectDeny(await decide(callers.staff, "DocumentAnnotation", "list"), /Office staff/);
    // The clerk decision: whoever works the case may mark its documents
    // (DD-001's tasks/notes/comments row applied to annotations). The
    // role gate passes here; case MEMBERSHIP is the guard's check in
    // the resource pipeline (proven in the acceptance suite).
    expect((await decide(callers.clerk, "DocumentAnnotation", "create")).allow).toBe(true);
  });

  it("extraction machinery is system-written: every PERSON is refused, the system passes its named seams only", async () => {
    // Even the managing partner: membership must not fall through to
    // the case-content allowance for these operations.
    expectDeny(
      await decide(callers.mp, "Document", "recordExtraction", { spec: { caseId: "case_a" } }),
      /system-written/,
    );
    expectDeny(await decide(callers.mp, "DocumentPage", "create"), /system-written/);

    expect((await decide(SYSTEM_PRINCIPAL, "DocumentPage", "create")).allow).toBe(true);
    expect((await decide(SYSTEM_PRINCIPAL, "Document", "recordExtraction")).allow).toBe(true);
    // The allowlist stays named seams, not a kind-wide grant.
    expectDeny(await decide(SYSTEM_PRINCIPAL, "Document", "create"), /System automation/);
    expectDeny(await decide(SYSTEM_PRINCIPAL, "DocumentPage", "search"), /System automation/);
  });
});

describe("case management (FR-CASE-002/003)", () => {
  it("juniors and clerks cannot open new matters; office staff cannot either", async () => {
    for (const caller of [callers.junior, callers.clerk, callers.staff]) {
      expectDeny(await decide(caller, "Case", "create"), /partners and associates/);
    }
  });

  it("a member who is NOT the lead cannot edit the case", async () => {
    const caseA = await store.getById("Case", "case_a");
    expectDeny(await decide(callers.clerk, "Case", "update", caseA), /lead lawyer/);
  });

  it("the lead lawyer edits their matter; partners edit any matter", async () => {
    const caseA = await store.getById("Case", "case_a");
    expect((await decide(callers.associate, "Case", "update", caseA)).allow).toBe(true);
    expect((await decide(callers.partner, "Case", "update", caseA)).allow).toBe(true);
  });

  it("lifecycle rides the same rule — a non-lead member cannot close a case", async () => {
    const caseA = await store.getById("Case", "case_a");
    expectDeny(await decide(callers.clerk, "Case", "updateStatus", caseA), /lead lawyer/);
  });

  it("only partners or the lead remove case members", async () => {
    const membership = { spec: { caseId: "case_a", memberId: "fmem_clerk" } };
    expectDeny(await decide(callers.clerk, "CaseMember", "remove", membership), /lead lawyer/);
    expect((await decide(callers.associate, "CaseMember", "remove", membership)).allow).toBe(true);
  });
});

describe("hearings — the clerk records, office staff never (FR-HEAR-002)", () => {
  it("a member clerk records an outcome", async () => {
    expect(
      (
        await decide(callers.clerk, "Hearing", "recordOutcome", {
          spec: { caseId: "case_a" },
        })
      ).allow,
    ).toBe(true);
  });

  it("office staff cannot create hearings or read them", async () => {
    expectDeny(await decide(callers.staff, "Hearing", "create"), /Office staff/);
    expectDeny(
      await decide(callers.staff, "Hearing", "get", { spec: { caseId: "case_a" } }),
      /case members and partners/,
    );
  });
});

describe("deadlines — clerks see, clerks never enter (FR-DEAD-001)", () => {
  it("clerks cannot create deadlines", async () => {
    expectDeny(await decide(callers.clerk, "Deadline", "create"), /lawyers/);
  });

  it("only the owner or a partner resolves a deadline", async () => {
    const deadline = { spec: { caseId: "case_a", ownerId: "fmem_assoc" } };
    expectDeny(
      await decide(callers.clerk, "Deadline", "updateStatus", deadline),
      /owner or a partner/,
    );
    expect((await decide(callers.associate, "Deadline", "updateStatus", deadline)).allow).toBe(
      true,
    );
    expect((await decide(callers.mp, "Deadline", "updateStatus", deadline)).allow).toBe(true);
  });
});

describe("money is the sharpest boundary (FR-AUTHZ-004)", () => {
  it("associates, juniors, clerks, and office staff never see fee arrangements", async () => {
    for (const caller of [callers.associate, callers.junior, callers.clerk, callers.staff]) {
      expectDeny(
        await decide(caller, "FeeArrangement", "get", { spec: { caseId: "case_a" } }),
        /partners only/,
      );
    }
  });

  it("the ledger and balances are partner-only reads — even for the case's own members", async () => {
    expectDeny(await decide(callers.associate, "LedgerEntry", "list"), /partners only/);
    expectDeny(await decide(callers.clerk, "LedgerEntry", "listOutstanding"), /partners only/);
    expect((await decide(callers.partner, "LedgerEntry", "listOutstanding")).allow).toBe(true);
  });

  it("lawyers below partner cannot record ledger entries at all", async () => {
    expectDeny(await decide(callers.associate, "LedgerEntry", "create"), /partners and office staff/);
  });

  it("office staff record RECEIPTS only — the guard refuses a charge", async () => {
    await expect(
      firm.guards.assertLedgerCreate(callers.staff, LedgerEntryKind.CHARGE),
    ).rejects.toThrowError(/receipts only/);
    await expect(
      firm.guards.assertLedgerCreate(callers.staff, LedgerEntryKind.RECEIPT),
    ).resolves.toBeDefined();
    await expect(
      firm.guards.assertLedgerCreate(callers.partner, LedgerEntryKind.CHARGE),
    ).resolves.toBeDefined();
  });
});

describe("accounts and roster (FR-AUTH-002, matrix: manage users/members)", () => {
  it("a PARTNER (not managing) cannot manage firm members", async () => {
    expectDeny(await decide(callers.partner, "FirmMember", "create"), /managing partner/);
    expectDeny(await decide(callers.partner, "FirmMember", "update"), /managing partner/);
  });

  it("the managing partner manages firm members; everyone sees the roster", async () => {
    expect((await decide(callers.mp, "FirmMember", "update")).allow).toBe(true);
    expect((await decide(callers.clerk, "FirmMember", "list")).allow).toBe(true);
  });

  it("the managing partner administers accounts in-product (FR-AUTH-002 as amended by DD-003 D4)", async () => {
    expect((await decide(callers.mp, "User", "create")).allow).toBe(true);
    expect((await decide(callers.mp, "User", "update")).allow).toBe(true);
    expect((await decide(callers.mp, "User", "issueActivationCode")).allow).toBe(true);
  });

  it("nobody below managing partner touches accounts — every role denied", async () => {
    for (const caller of [callers.partner, callers.associate, callers.junior, callers.clerk, callers.staff]) {
      expectDeny(await decide(caller, "User", "create"), /operator or the managing partner/);
      expectDeny(await decide(caller, "User", "update"), /operator or the managing partner/);
      expectDeny(
        await decide(caller, "User", "issueActivationCode"),
        /operator or the managing partner/,
      );
    }
  });

  it("SetPassword stays operator-only break-glass — even the managing partner is refused", async () => {
    // Setting a password FOR someone is a silent-takeover lever; the
    // activation code path is visible to the account holder.
    expectDeny(await decide(callers.mp, "User", "setPassword"), /operator/);
  });

  it("a user reads their OWN identity record; the managing partner reads anyone's", async () => {
    expect(
      (await decide(callers.associate, "User", "get", { metadata: { id: "usr_assoc" } })).allow,
    ).toBe(true);
    expectDeny(
      await decide(callers.associate, "User", "get", { metadata: { id: "usr_partner" } }),
      /operator or the managing partner/,
    );
    expect(
      (await decide(callers.mp, "User", "get", { metadata: { id: "usr_partner" } })).allow,
    ).toBe(true);
  });
});

describe("notifications belong to their recipient", () => {
  // recipient_id is a USER id — the proto's documented inbox exception.
  const notification = create(NotificationSchema, {
    metadata: meta("notif_1"),
    spec: {
      recipientId: "usr_assoc",
      type: NotificationType.TASK_ASSIGNMENT,
      title: "t",
      dedupKey: "k",
    },
  });

  it("marking someone else's notification read is denied", async () => {
    expectDeny(
      await decide(callers.partner, "Notification", "markRead", notification),
      /recipient/,
    );
  });

  it("the recipient marks it read; no user creates notifications", async () => {
    expect((await decide(callers.associate, "Notification", "markRead", notification)).allow).toBe(
      true,
    );
    expectDeny(await decide(callers.mp, "Notification", "create"), /system-written/);
  });
});

describe("audit history (FR-AUDIT-001)", () => {
  it("non-partners cannot read change history; no user writes it", async () => {
    for (const caller of [callers.associate, callers.clerk, callers.staff]) {
      expectDeny(await decide(caller, "AuditEntry", "list"), /partners only/);
    }
    expectDeny(await decide(callers.mp, "AuditEntry", "create"), /system-written/);
    expect((await decide(callers.partner, "AuditEntry", "list")).allow).toBe(true);
  });
});

describe("non-person principals stay in their lanes", () => {
  it("the operator administers accounts and NOTHING else", async () => {
    expect((await decide(callers.operator, "FirmMember", "create")).allow).toBe(true);
    expect((await decide(callers.operator, "User", "setPassword")).allow).toBe(true);
    expectDeny(await decide(callers.operator, "Case", "create"), /administers accounts/);
    expectDeny(await decide(callers.operator, "LedgerEntry", "list"), /administers accounts/);
  });

  it("the system principal holds exactly its four named seams", async () => {
    expect((await decide(SYSTEM_PRINCIPAL, "Notification", "create")).allow).toBe(true);
    expect((await decide(SYSTEM_PRINCIPAL, "AuditEntry", "create")).allow).toBe(true);
    expect((await decide(SYSTEM_PRINCIPAL, "Case", "update")).allow).toBe(true);
    expect((await decide(SYSTEM_PRINCIPAL, "CaseMember", "create")).allow).toBe(true);
    expectDeny(await decide(SYSTEM_PRINCIPAL, "Hearing", "create"), /may not/);
    expectDeny(await decide(SYSTEM_PRINCIPAL, "Case", "get"), /may not/);
  });
});

describe("query-scoping facts (the guards the list handlers consume)", () => {
  it("partners are unscoped; members get exactly their active case ids", async () => {
    const partner = await firm.guards.requireMember(callers.partner);
    expect(await firm.guards.visibleCaseIds(partner)).toBeUndefined();

    const clerk = await firm.guards.requireMember(callers.clerk);
    expect(await firm.guards.visibleCaseIds(clerk)).toEqual(["case_a"]);

    // The junior's only membership was removed: an EMPTY scope, which
    // matches nothing — never a fallback to firm-wide.
    const junior = await firm.guards.requireMember(callers.junior);
    expect(await firm.guards.visibleCaseIds(junior)).toEqual([]);
  });

  it("assertCaseContent(clerkAllowed:false) refuses a member clerk", async () => {
    await expect(
      firm.guards.assertCaseContent(callers.clerk, "case_a", { clerkAllowed: false }),
    ).rejects.toThrowError(/lawyers/i);
    await expect(
      firm.guards.assertCaseContent(callers.clerk, "case_a"),
    ).resolves.toBeDefined();
  });
});
