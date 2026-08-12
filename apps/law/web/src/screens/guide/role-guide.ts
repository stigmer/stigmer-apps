/**
 * The Guide's role descriptions as DATA, keyed by the generated
 * FirmRole enum. `satisfies` over the six real roles makes coverage a
 * compile-time fact: adding a seventh role to the proto will not build
 * until the Guide describes it — the page and the policy matrix
 * (DD-001's who-sees-what table, enforced in the backend's policy
 * module) cannot silently diverge.
 *
 * Plain language only: these sentences are read by lawyers and clerks,
 * and they are the product's own explanation of a refusal ("no money"
 * is why a clerk's sidebar has no Money entry). Role NAMES come from
 * firmRoleLabel — one label source for roster, guide, and pickers.
 */

import { FirmRole } from "../../gen/stigmer/law/firmmember/v1/firmmember_pb.js";

export interface RoleGuideEntry {
  /** What this role can see and do, in one or two plain sentences. */
  readonly summary: string;
}

/** A real firm role — UNSPECIFIED is a proto artifact, not a role. */
export type GuideRole = Exclude<FirmRole, FirmRole.UNSPECIFIED>;

/** The six real roles, seniority order — the order the firm thinks in
 * (same ordering the roster uses). */
export const GUIDE_ROLES: readonly GuideRole[] = [
  FirmRole.MANAGING_PARTNER,
  FirmRole.PARTNER,
  FirmRole.ASSOCIATE,
  FirmRole.JUNIOR,
  FirmRole.CLERK,
  FirmRole.OFFICE_STAFF,
];

export const ROLE_GUIDE = {
  [FirmRole.MANAGING_PARTNER]: {
    summary:
      "Everything a partner can, plus running the firm itself: " +
      "adding members, issuing activation codes, and deactivating " +
      "accounts.",
  },
  [FirmRole.PARTNER]: {
    summary:
      "Every matter in full, and the money: fee arrangements, the " +
      "ledger, and outstanding balances.",
  },
  [FirmRole.ASSOCIATE]: {
    summary:
      "Their own matters in full. Other matters appear as a single " +
      "line — file number, forum, next date — so they know a matter " +
      "exists without seeing its contents. Can open new clients and " +
      "matters. No money.",
  },
  [FirmRole.JUNIOR]: {
    summary:
      "Their own matters in full: the diary, deadlines, tasks, notes, " +
      "and documents. Cannot open new matters or change who is on " +
      "them. No money.",
  },
  [FirmRole.CLERK]: {
    summary:
      "The diary keeper. On their matters they record hearing " +
      "outcomes, keep tasks and notes, and file documents. They see " +
      "deadlines but do not enter them. Matters they are not on are " +
      "not visible to them at all. No money.",
  },
  [FirmRole.OFFICE_STAFF]: {
    summary:
      "No case contents. Can record money received (receipts) in the " +
      "ledger — entry only, without seeing arrangements or balances.",
  },
} as const satisfies Record<GuideRole, RoleGuideEntry>;
