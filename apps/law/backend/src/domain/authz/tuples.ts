/**
 * The tuple projection (project DD-003): how the firm's rows become the
 * engine's relationship tuples. A PURE function of the store — the
 * engine is always a rebuildable index, never a second source of truth.
 *
 * | Source rows                          | Tuples                                  |
 * |--------------------------------------|-----------------------------------------|
 * | FirmMember, spec.active == true      | firm:firm#<role>@user:<userId>          |
 * | CaseMember, status.active == true    | case:<caseId>#member@user:<userId>      |
 * | Case                                 | case:<id>#firm@firm:firm (+ #lead@user) |
 *
 * Principals are always identity USER ids: CaseMember.memberId and
 * Case.spec.leadLawyerId are FirmMember ids, joined to their user here,
 * so one principal vocabulary serves every check.
 *
 * Deliberate asymmetry, kept consistent between this full projection
 * and the per-request deltas (a reconciler that disagrees with the
 * incremental path would flip-flop every run): deactivating a
 * FirmMember deletes only the ROLE tuple — membership/lead tuples
 * remain, made inert by the model's role intersection and by the
 * policy's DB liveness gate, and reactivation restores access without
 * rebuilding them (exactly the row semantics: memberships survive a
 * deactivation).
 *
 * Sync failures are contained, never thrown (DD-003 D1a): the row write
 * already stands, and a missed tuple is UNDER-permission healed by the
 * boot/periodic reconcile — the fail-closed direction by construction.
 */

import type { ResourceStore } from "@stigmer/resource-api";
import { ref, type AuthorizationEngine, type TupleKey } from "@stigmer/authorization";
import type { Case } from "../../gen/stigmer/law/case/v1/case_pb.js";
import type { CaseMember } from "../../gen/stigmer/law/casemember/v1/casemember_pb.js";
import {
  FirmRole,
  type FirmMember,
} from "../../gen/stigmer/law/firmmember/v1/firmmember_pb.js";

/** The singleton firm object — the store is the tenancy boundary (T04b D1). */
export const FIRM_OBJECT = ref("firm", "firm");

export function userRef(userId: string): string {
  return ref("user", userId);
}

export function caseRef(caseId: string): string {
  return ref("case", caseId);
}

/** FirmRole → the model's role relation. UNSPECIFIED projects nothing. */
const ROLE_RELATIONS: Readonly<Partial<Record<FirmRole, string>>> = {
  [FirmRole.MANAGING_PARTNER]: "managing_partner",
  [FirmRole.PARTNER]: "partner",
  [FirmRole.ASSOCIATE]: "associate",
  [FirmRole.JUNIOR]: "junior",
  [FirmRole.CLERK]: "clerk",
  [FirmRole.OFFICE_STAFF]: "office_staff",
};

/** The member's role tuple, or undefined when nothing should exist
 * (inactive, unknown role, malformed row — all fail closed). */
export function firmMemberRoleTuple(member: FirmMember): TupleKey | undefined {
  const spec = member.spec;
  if (!spec || spec.active !== true || !spec.userId) return undefined;
  const relation = ROLE_RELATIONS[spec.role];
  if (!relation) return undefined;
  return { user: userRef(spec.userId), relation, object: FIRM_OBJECT };
}

function caseFirmTuple(caseId: string): TupleKey {
  return { user: FIRM_OBJECT, relation: "firm", object: caseRef(caseId) };
}

function caseMemberTuple(userId: string, caseId: string): TupleKey {
  return { user: userRef(userId), relation: "member", object: caseRef(caseId) };
}

function caseLeadTuple(userId: string, caseId: string): TupleKey {
  return { user: userRef(userId), relation: "lead", object: caseRef(caseId) };
}

/* --------------------------- full projection ------------------------ */

const PAGE = 100;

async function listAll<T>(
  store: ResourceStore,
  kind: string,
): Promise<readonly T[]> {
  const all: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { items } = await store.list(kind, {
      limit: PAGE,
      offset,
      orderBy: { field: "createdAt", direction: "asc", nulls: "last" },
    });
    all.push(...(items as T[]));
    if (items.length < PAGE) return all;
  }
}

/** The desired tuple set, computed from the rows — the reconciler's input. */
export async function projectAuthorizationTuples(
  store: ResourceStore,
): Promise<readonly TupleKey[]> {
  const [members, cases, memberships] = await Promise.all([
    listAll<FirmMember>(store, "FirmMember"),
    listAll<Case>(store, "Case"),
    listAll<CaseMember>(store, "CaseMember"),
  ]);

  // FirmMember id → user id, from every row (active or not — see the
  // module doc's deliberate asymmetry).
  const userOf = new Map<string, string>();
  for (const member of members) {
    if (member.metadata?.id && member.spec?.userId) {
      userOf.set(member.metadata.id, member.spec.userId);
    }
  }

  const tuples: TupleKey[] = [];
  for (const member of members) {
    const roleTuple = firmMemberRoleTuple(member);
    if (roleTuple) tuples.push(roleTuple);
  }
  for (const theCase of cases) {
    const caseId = theCase.metadata?.id;
    if (!caseId) continue;
    tuples.push(caseFirmTuple(caseId));
    const leadUserId = userOf.get(theCase.spec?.leadLawyerId ?? "");
    if (leadUserId) tuples.push(caseLeadTuple(leadUserId, caseId));
  }
  for (const membership of memberships) {
    if (membership.status?.active !== true) continue;
    const caseId = membership.spec?.caseId;
    const memberUserId = userOf.get(membership.spec?.memberId ?? "");
    if (caseId && memberUserId) tuples.push(caseMemberTuple(memberUserId, caseId));
  }
  return tuples;
}

/* ------------------------ per-request deltas ------------------------ */

export interface TupleDelta {
  readonly writes: readonly TupleKey[];
  readonly deletes: readonly TupleKey[];
}

const NO_DELTA: TupleDelta = { writes: [], deletes: [] };

function sameTuple(a: TupleKey | undefined, b: TupleKey | undefined): boolean {
  return a?.user === b?.user && a?.relation === b?.relation && a?.object === b?.object;
}

/** Role/active transition on a FirmMember write (create: previous absent). */
export function firmMemberTupleDelta(
  previous: FirmMember | undefined,
  next: FirmMember,
): TupleDelta {
  const before = previous ? firmMemberRoleTuple(previous) : undefined;
  const after = firmMemberRoleTuple(next);
  if (sameTuple(before, after)) return NO_DELTA;
  return {
    writes: after ? [after] : [],
    deletes: before ? [before] : [],
  };
}

/** Firm link on create; lead transition on any Case write. */
export async function caseTupleDelta(
  store: ResourceStore,
  previous: Case | undefined,
  next: Case,
): Promise<TupleDelta> {
  const caseId = next.metadata?.id;
  if (!caseId) return NO_DELTA;

  const writes: TupleKey[] = [];
  const deletes: TupleKey[] = [];
  if (!previous) {
    writes.push(caseFirmTuple(caseId));
  }

  const previousLead = previous?.spec?.leadLawyerId ?? "";
  const nextLead = next.spec?.leadLawyerId ?? "";
  if (previousLead !== nextLead) {
    const previousUserId = await resolveMemberUserId(store, previousLead);
    if (previousUserId) deletes.push(caseLeadTuple(previousUserId, caseId));
    const nextUserId = await resolveMemberUserId(store, nextLead);
    if (nextUserId) writes.push(caseLeadTuple(nextUserId, caseId));
  }

  if (writes.length === 0 && deletes.length === 0) return NO_DELTA;
  return { writes, deletes };
}

/** Membership activation state on a CaseMember write (create or soft-close). */
export async function caseMemberTupleDelta(
  store: ResourceStore,
  previous: CaseMember | undefined,
  next: CaseMember,
): Promise<TupleDelta> {
  const wasActive = previous?.status?.active === true;
  const isActive = next.status?.active === true;
  if (wasActive === isActive) return NO_DELTA;

  const caseId = next.spec?.caseId;
  const memberUserId = await resolveMemberUserId(store, next.spec?.memberId ?? "");
  if (!caseId || !memberUserId) return NO_DELTA;
  const tuple = caseMemberTuple(memberUserId, caseId);
  return isActive ? { writes: [tuple], deletes: [] } : { writes: [], deletes: [tuple] };
}

async function resolveMemberUserId(
  store: ResourceStore,
  memberId: string,
): Promise<string | undefined> {
  if (!memberId) return undefined;
  const member = (await store.getById("FirmMember", memberId)) as FirmMember | undefined;
  return member?.spec?.userId || undefined;
}

/* --------------------------- contained sync ------------------------- */

/**
 * Apply a delta without letting an engine failure surface: the row is
 * already persisted, and reconcile heals the miss (D1a). The log line
 * is deliberately loud — it is the only in-request trace of drift.
 */
export async function applyTupleDeltaSafely(
  engine: AuthorizationEngine,
  delta: TupleDelta | Promise<TupleDelta>,
  context: string,
): Promise<void> {
  try {
    const resolved = await delta;
    if (resolved.writes.length === 0 && resolved.deletes.length === 0) return;
    await engine.write({ writes: resolved.writes, deletes: resolved.deletes });
  } catch (err) {
    console.error(
      `AUTHORIZATION TUPLE SYNC FAILED (${context}) — engine drift until the next reconcile:`,
      err,
    );
  }
}
