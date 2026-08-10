/**
 * The reminder sweep (Gate-1 Q4) — the clock-driven notification writer
 * nothing else in the stack provides: deadline escalation (FR-DEAD-002),
 * unrecorded-outcome nags (FR-HEAR-005), and in-app hearing reminders
 * (FR-NOTIF-001). An interval loop, not a scheduler: calendar-triggered
 * reminders tolerate minutes of latency by nature (the 30s delivery
 * envelope governs event-triggered notifications, not these).
 *
 * IDEMPOTENT AND MULTI-REPLICA SAFE BY CONSTRUCTION: every write goes
 * through the full pipeline as the system principal, and Notification's
 * unique dedup_key answers ALREADY_EXISTS for anything already sent —
 * the task-assignment handler's arrangement, applied to time. Windows
 * are RANGES, not exact days, so a sweep that was down on the exact
 * T-3 still fires the T-3 escalation the moment it is back.
 *
 * Extraction seam (DD-A1): the loop/dedup shape is vertical-agnostic;
 * the queries and wordings are law. When vertical #2 wants reminders,
 * the shape moves to the commons and this file keeps only the domain.
 *
 * Bounded work per tick (one page per category): at firm scale the
 * backlog cannot exceed a page, and dedup makes re-scanning cheap; a
 * product tier with thousands of open deadlines revisits this with the
 * warm knowledge that dedup already made the sweep restartable.
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { CallerPrincipal, ResourceStore } from "@stigmer/resource-api";
import { SYSTEM_PRINCIPAL } from "@stigmer/resource-api";
import type { Case } from "../../gen/stigmer/law/case/v1/case_pb.js";
import type { CaseMember } from "../../gen/stigmer/law/casemember/v1/casemember_pb.js";
import type { Deadline } from "../../gen/stigmer/law/deadline/v1/deadline_pb.js";
import type { FirmMember } from "../../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import type { Hearing } from "../../gen/stigmer/law/hearing/v1/hearing_pb.js";
import {
  NotificationSchema,
  NotificationType,
  type Notification,
} from "../../gen/stigmer/law/notification/v1/notification_pb.js";
import { addDaysToIsoDate, todayInFirmTimezone } from "../firm-clock.js";

const OPEN_TEXT = "DEADLINE_STATE_OPEN";
const PAGE = 100;

export interface SweepDeps {
  store: ResourceStore;
  createNotification: (input: Notification, caller: CallerPrincipal) => Promise<Notification>;
}

/** The escalation ladder: each window is a RANGE ending at its rung, so
 * a missed day still escalates on the next tick. */
const DEADLINE_WINDOWS: readonly { name: string; fromDays: number; toDays: number }[] = [
  { name: "t-7", fromDays: 4, toDays: 7 },
  { name: "t-3", fromDays: 2, toDays: 3 },
  { name: "t-1", fromDays: 1, toDays: 1 },
  { name: "day-of", fromDays: 0, toDays: 0 },
];

export async function runSweepOnce(deps: SweepDeps): Promise<void> {
  const today = todayInFirmTimezone();
  await sweepDeadlines(deps, today);
  await sweepUnrecordedOutcomes(deps, today);
  await sweepHearingReminders(deps, today);
}

/** Starts the loop; returns a stopper. The first pass runs immediately
 * so a fresh boot never waits an interval to notice today's board. */
export function startReminderSweep(deps: SweepDeps, intervalMs: number): () => void {
  const tick = () =>
    runSweepOnce(deps).catch((err) => {
      // The sweep must survive its own failures: dedup makes the next
      // tick a free retry, so log loudly and keep the loop alive.
      console.error("reminder sweep failed (retrying next tick):", err);
    });
  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.(); // never hold the process open just to remind people
  return () => clearInterval(timer);
}

/* ------------------------- deadline escalation ---------------------- */

async function sweepDeadlines(deps: SweepDeps, today: string): Promise<void> {
  for (const window of DEADLINE_WINDOWS) {
    const { items } = await deps.store.list("Deadline", {
      limit: PAGE,
      offset: 0,
      orderBy: { field: "dueDate", direction: "asc", nulls: "last" },
      filter: {
        state: OPEN_TEXT,
        dueDate: {
          gte: addDaysToIsoDate(today, window.fromDays),
          lte: addDaysToIsoDate(today, window.toDays),
        },
      },
    });
    for (const item of items as Deadline[]) {
      const ownerUserId = await userIdOfMember(deps.store, item.spec?.ownerId);
      if (!ownerUserId) continue;
      const due = item.spec?.dueDate ?? "";
      const body =
        due === today
          ? `"${item.spec?.title ?? ""}" is due TODAY (${due}).`
          : `"${item.spec?.title ?? ""}" is due on ${due}.`;
      await notify(deps, {
        recipientId: ownerUserId,
        type: NotificationType.DEADLINE_APPROACHING,
        title: due === today ? "Deadline due today" : "Deadline approaching",
        body,
        target: { kind: "Deadline", id: item.metadata?.id ?? "" },
        dedupKey: `deadline:${item.metadata?.id}:${window.name}`,
      });
    }
  }
}

/* ----------------------- unrecorded-outcome nags --------------------- */

async function sweepUnrecordedOutcomes(deps: SweepDeps, today: string): Promise<void> {
  const { items } = await deps.store.list("Hearing", {
    limit: PAGE,
    offset: 0,
    orderBy: { field: "date", direction: "asc", nulls: "last" },
    filter: { outcomeKind: { absent: true }, date: { lt: today } },
  });
  for (const hearing of items as Hearing[]) {
    const theCase = (await deps.store.getById("Case", hearing.spec?.caseId ?? "")) as
      | Case
      | undefined;
    const leadUserId = await userIdOfMember(deps.store, theCase?.spec?.leadLawyerId);
    if (!leadUserId) continue;
    await notify(deps, {
      recipientId: leadUserId,
      type: NotificationType.UNRECORDED_OUTCOME,
      title: "Hearing outcome not recorded",
      body:
        `The hearing on ${hearing.spec?.date ?? ""} (${theCase?.spec?.fileNumber ?? ""}) ` +
        `has no recorded outcome yet. Please record what happened.`,
      target: { kind: "Hearing", id: hearing.metadata?.id ?? "" },
      // Once per hearing: the notification fires a single time; the
      // home surface keeps nagging until a human records the outcome.
      dedupKey: `unrecorded_outcome:${hearing.metadata?.id}`,
    });
  }
}

/* ------------------------- hearing reminders ------------------------- */

async function sweepHearingReminders(deps: SweepDeps, today: string): Promise<void> {
  const tomorrow = addDaysToIsoDate(today, 1);
  const { items } = await deps.store.list("Hearing", {
    limit: PAGE,
    offset: 0,
    orderBy: { field: "date", direction: "asc", nulls: "last" },
    filter: { outcomeKind: { absent: true }, date: { gte: today, lte: tomorrow } },
  });
  for (const hearing of items as Hearing[]) {
    const caseId = hearing.spec?.caseId ?? "";
    const theCase = (await deps.store.getById("Case", caseId)) as Case | undefined;
    // The whole working team, clerk included — J2 is the clerk's
    // evening; attendees are unknown until the outcome is recorded.
    const memberships = await deps.store.list("CaseMember", {
      limit: PAGE,
      offset: 0,
      orderBy: { field: "createdAt", direction: "asc", nulls: "last" },
      filter: { caseId, active: "true" },
    });
    const when = hearing.spec?.date === today ? "today" : "tomorrow";
    for (const membership of memberships.items as CaseMember[]) {
      const userId = await userIdOfMember(deps.store, membership.spec?.memberId);
      if (!userId) continue;
      await notify(deps, {
        recipientId: userId,
        type: NotificationType.HEARING_REMINDER,
        title: `Hearing ${when}`,
        body:
          `${theCase?.spec?.fileNumber ?? ""} is listed ${when} (${hearing.spec?.date ?? ""})` +
          (hearing.spec?.purpose ? ` for ${hearing.spec.purpose}.` : "."),
        target: { kind: "Hearing", id: hearing.metadata?.id ?? "" },
        // The date is part of the key: a reschedule legitimately
        // reminds again; a re-scan never does.
        dedupKey: `hearing_reminder:${hearing.metadata?.id}:${membership.spec?.memberId}:${hearing.spec?.date}`,
      });
    }
  }
}

/* ------------------------------ shared ------------------------------ */

async function userIdOfMember(
  store: ResourceStore,
  memberId: string | undefined,
): Promise<string | undefined> {
  if (!memberId) return undefined;
  const member = (await store.getById("FirmMember", memberId)) as FirmMember | undefined;
  // A deactivated member gets no reminders — their work moved on.
  if (member?.spec?.active !== true) return undefined;
  return member.spec.userId;
}

async function notify(
  deps: SweepDeps,
  spec: {
    recipientId: string;
    type: NotificationType;
    title: string;
    body: string;
    target: { kind: string; id: string };
    dedupKey: string;
  },
): Promise<void> {
  try {
    await deps.createNotification(create(NotificationSchema, { spec }), SYSTEM_PRINCIPAL);
  } catch (err) {
    if (ConnectError.from(err).code === Code.AlreadyExists) {
      return; // already sent — the dedup key doing its one job
    }
    throw err;
  }
}
