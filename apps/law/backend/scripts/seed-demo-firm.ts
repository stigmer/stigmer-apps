/**
 * Demo-firm seeding — the committed instrument that puts a fictional,
 * demo-ready dataset onto a DEPLOYED firm through the product's own
 * surfaces (the mcp-smoke.ts practice: a deploy is accepted by running a
 * committed script against it, never by hand-typed calls that cannot be
 * repeated). Everything runs over the wire: identities are corrected
 * through the operator path, records are created AS a signed-in staff
 * member so audit fields read exactly like production rows. No store
 * writes, ever.
 *
 *   npx tsx scripts/seed-demo-firm.ts --url https://<firm-hostname> \
 *     --partner partner@firm.example --partner-password <pw> \
 *     [--clerk clerk@firm.example] \
 *     [--operator-key opk_… --partner-phone +91… --clerk-phone +91…]
 *
 * Phones are ARGUMENTS by design: a deployment's real handset numbers
 * are customer data and must never appear in this public repo (the
 * customer-data guard scans every path). Everything inline below is
 * fictional by construction.
 *
 * Firm profiles: the partner is ensured MANAGING_PARTNER and the clerk
 * CLERK (FirmMember rows) — with --operator-key when neither profile
 * exists yet (the first profile is a chicken-and-egg: profile
 * management needs a managing partner, who needs a profile).
 *
 * Idempotency: cases are keyed by their firm file number and clients by
 * an exact-name search, so re-running skips what exists. Hearings,
 * deadlines, money, tasks, and notes have no natural key — they are
 * seeded ONLY when their case was created by this run, so a re-run
 * never duplicates them. DOCUMENTS key by (case, file name) and seed
 * onto existing cases too — the demo file room reaches firms whose
 * cases predate document intelligence. To re-seed from scratch, reset
 * the firm's database first (the cutover runbook's wipe step).
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { AuthService, UserSchema, UserService } from "@stigmer/identity";
import {
  CaseSchema,
  CaseService,
  ClientRole,
  ForumKind,
  type Case,
} from "../src/gen/stigmer/law/case/v1/case_pb.js";
import {
  CaseMemberSchema,
  CaseMemberService,
  RoleOnCase,
} from "../src/gen/stigmer/law/casemember/v1/casemember_pb.js";
import { CaseNoteSchema, CaseNoteService } from "../src/gen/stigmer/law/casenote/v1/casenote_pb.js";
import { ClientSchema, ClientService } from "../src/gen/stigmer/law/client/v1/client_pb.js";
import {
  DeadlineSchema,
  DeadlineService,
} from "../src/gen/stigmer/law/deadline/v1/deadline_pb.js";
import { DocumentService } from "../src/gen/stigmer/law/document/v1/document_pb.js";
import {
  FeeArrangementSchema,
  FeeArrangementService,
  FeeKind,
} from "../src/gen/stigmer/law/feearrangement/v1/feearrangement_pb.js";
import {
  FirmMemberSchema,
  FirmMemberService,
  FirmRole,
} from "../src/gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import {
  HearingSchema,
  HearingService,
  OutcomeKind,
} from "../src/gen/stigmer/law/hearing/v1/hearing_pb.js";
import {
  LedgerEntryKind,
  LedgerEntrySchema,
  LedgerEntryService,
} from "../src/gen/stigmer/law/ledgerentry/v1/ledgerentry_pb.js";
import { TaskPriority, TaskSchema, TaskService } from "../src/gen/stigmer/law/task/v1/task_pb.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const url = arg("url");
const partnerEmail = arg("partner") ?? "partner@firm.example";
const clerkEmail = arg("clerk") ?? "clerk@firm.example";
const partnerPassword = arg("partner-password");
const operatorKey = arg("operator-key");
const partnerPhone = arg("partner-phone");
const clerkPhone = arg("clerk-phone");

if (!url || !partnerPassword) {
  console.error(
    "usage: npx tsx scripts/seed-demo-firm.ts --url <firm-base-url> " +
      "--partner-password <pw> [--partner <email>] [--clerk <email>] " +
      "[--operator-key opk_… --partner-phone +E164 --clerk-phone +E164]",
  );
  process.exit(2);
}
if ((partnerPhone || clerkPhone) && !operatorKey) {
  console.error("setting phones requires --operator-key (User.Update is operator-only)");
  process.exit(2);
}

const transport: Transport = createConnectTransport({ baseUrl: url, httpVersion: "1.1" });
const users = createClient(UserService, transport);
const auth = createClient(AuthService, transport);
const firmMembers = createClient(FirmMemberService, transport);
const clients = createClient(ClientService, transport);
const cases = createClient(CaseService, transport);
const hearings = createClient(HearingService, transport);
const deadlines = createClient(DeadlineService, transport);
const fees = createClient(FeeArrangementService, transport);
const ledger = createClient(LedgerEntryService, transport);
const tasks = createClient(TaskService, transport);
const caseNotes = createClient(CaseNoteService, transport);
const documents = createClient(DocumentService, transport);

const asOperator = { headers: { authorization: `Bearer ${operatorKey}` } };

/** Today's calendar date in the firm's timezone (Asia/Kolkata), +N days. */
function firmDate(daysFromToday: number): string {
  const now = new Date(Date.now() + daysFromToday * 24 * 60 * 60 * 1000);
  // en-CA formats as YYYY-MM-DD — the contract's calendar-date shape.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

/**
 * Sets a user's phone through the operator Update path. Read-modify-write
 * because Update is full spec replacement — sending only the phone would
 * clear the name.
 */
async function bindPhone(email: string, phone: string): Promise<void> {
  const existing = await users.get({ email }, asOperator);
  await users.update(
    create(UserSchema, {
      metadata: { id: existing.metadata?.id },
      spec: { email, name: existing.spec?.name, phone },
    }),
    asOperator,
  );
  console.log(`phone bound: ${email} (…${phone.slice(-4)})`);
}

/** Ensures a FirmMember profile exists (operator path), returns its id. */
async function ensureProfile(email: string, role: FirmRole): Promise<string> {
  if (!operatorKey) {
    throw new Error(
      `--operator-key is required to ensure firm profiles (none found for ${email})`,
    );
  }
  const user = await users.get({ email }, asOperator);
  const userId = user.metadata?.id as string;
  try {
    const existing = await firmMembers.get({ userId }, asOperator);
    return existing.metadata?.id as string;
  } catch (err) {
    if (ConnectError.from(err).code !== Code.NotFound) throw err;
  }
  const created = await firmMembers.create(
    create(FirmMemberSchema, { spec: { userId, role } }),
    asOperator,
  );
  console.log(`firm profile created: ${email} (${FirmRole[role]})`);
  return created.metadata?.id as string;
}

if (partnerPhone) await bindPhone(partnerEmail, partnerPhone);
if (clerkPhone) await bindPhone(clerkEmail, clerkPhone);

const partnerMemberId = await ensureProfile(partnerEmail, FirmRole.MANAGING_PARTNER);
const clerkMemberId = await ensureProfile(clerkEmail, FirmRole.CLERK);

// Everything below is created AS THE PARTNER — a real login, so every
// record's createdBy is a person, exactly like production data entry.
const login = await auth.login({ email: partnerEmail, password: partnerPassword });
const asPartner = { headers: { authorization: `Bearer ${login.accessToken}` } };

/* ------------------------------------------------------------------ */
/* The dataset (fictional by construction)                             */
/* ------------------------------------------------------------------ */

/** Finds a client by exact name (idempotency: names are the register's
 * working identity even without a natural key) or creates it. */
async function ensureClient(displayName: string, notes: string): Promise<string> {
  const found = await clients.search({ query: displayName, limit: 10 }, asPartner);
  const exact = found.clients.find((c) => c.spec?.displayName === displayName);
  if (exact) return exact.metadata?.id as string;
  const created = await clients.create(
    create(ClientSchema, { spec: { displayName, notes } }),
    asPartner,
  );
  console.log(`client created: ${displayName}`);
  return created.metadata?.id as string;
}

const meridianId = await ensureClient("Meridian Textiles Pvt Ltd", "fictional demo client");
const raghavanId = await ensureClient("S. Raghavan", "fictional demo client");
const blueHarbourId = await ensureClient("Blue Harbour Logistics", "fictional demo client");
const kavyaId = await ensureClient("Kavya Menon", "fictional demo client");

const SEED_CASES: {
  fileNumber: string;
  clientId: string;
  clientRole: ClientRole;
  opposing: { name: string; counselName?: string }[];
  forumKind: ForumKind;
  forumName: string;
  caseType: string;
  stage: string;
}[] = [
  {
    fileNumber: "CS/2026/041",
    clientId: meridianId,
    clientRole: ClientRole.PLAINTIFF,
    opposing: [{ name: "Sunrise Cotton Traders", counselName: "Sri K. Rao" }],
    forumKind: ForumKind.DISTRICT_COURT,
    forumName: "III Addl District Court, Hyderabad",
    caseType: "civil suit",
    stage: "written statement",
  },
  {
    fileNumber: "CRL/2026/107",
    clientId: raghavanId,
    clientRole: ClientRole.ACCUSED,
    opposing: [{ name: "State of Telangana" }],
    forumKind: ForumKind.DISTRICT_COURT,
    forumName: "II Metropolitan Magistrate, Hyderabad",
    caseType: "criminal",
    stage: "evidence",
  },
  {
    fileNumber: "ARB/2026/012",
    clientId: blueHarbourId,
    clientRole: ClientRole.PETITIONER,
    opposing: [{ name: "Deccan Freight Carriers", counselName: "Smt L. Devi" }],
    forumKind: ForumKind.OTHER,
    forumName: "Arbitral Tribunal (Sri Justice R., retd.)",
    caseType: "arbitration",
    stage: "claim",
  },
  {
    fileNumber: "WP/2026/220",
    clientId: kavyaId,
    clientRole: ClientRole.PETITIONER,
    opposing: [{ name: "State of Telangana" }],
    forumKind: ForumKind.HIGH_COURT,
    forumName: "High Court for the State of Telangana",
    caseType: "writ petition",
    stage: "admission",
  },
];

/* ------------------------------------------------------------------ */
/* Seed                                                                */
/* ------------------------------------------------------------------ */

const createdCases = new Map<string, Case>();

for (const seed of SEED_CASES) {
  try {
    const existing = await cases.get({ fileNumber: seed.fileNumber }, asPartner);
    console.log(
      `case ${seed.fileNumber} exists (id ${existing.metadata?.id}) — skipping it and its records`,
    );
    continue;
  } catch (err) {
    if (ConnectError.from(err).code !== Code.NotFound) throw err;
  }
  const created = await cases.create(
    create(CaseSchema, {
      spec: {
        fileNumber: seed.fileNumber,
        clientId: seed.clientId,
        clientRole: seed.clientRole,
        opposingParties: seed.opposing,
        forum: { forumKind: seed.forumKind, name: seed.forumName },
        caseType: seed.caseType,
        stage: seed.stage,
        leadLawyerId: partnerMemberId,
      },
    }),
    asPartner,
  );
  createdCases.set(seed.fileNumber, created);
  console.log(`case ${seed.fileNumber} created`);
}

const caseId = (fileNumber: string) => createdCases.get(fileNumber)?.metadata?.id as string;

/* The diary: CS gets depth (a completed appearance whose outcome
 * auto-scheduled the next one, with the clerk's cause-list capture);
 * CRL and ARB get scheduled hearings; ARB also gets a PAST hearing
 * with no outcome (the unrecorded-outcome nag fixture); WP gets
 * nothing (the no-next-date fixture). */
if (createdCases.has("CS/2026/041")) {
  await createClient(CaseMemberService, transport).create(
    create(CaseMemberSchema, {
      spec: {
        caseId: caseId("CS/2026/041"),
        memberId: clerkMemberId,
        roleOnCase: RoleOnCase.CLERK,
      },
    }),
    asPartner,
  );
  const past = await hearings.create(
    create(HearingSchema, {
      spec: {
        caseId: caseId("CS/2026/041"),
        date: firmDate(-7),
        purpose: "filing of written statement",
        listSerialNumber: "47",
        courtHall: "3",
      },
    }),
    asPartner,
  );
  await hearings.recordOutcome(
    {
      id: past.metadata?.id as string,
      outcomeKind: OutcomeKind.ADJOURNED,
      outcomeNotes: "Defense sought time; court granted a short adjournment.",
      attendedBy: [partnerMemberId, clerkMemberId],
      nextDate: firmDate(2),
      nextPurpose: "written statement (final chance)",
    },
    asPartner,
  );
  console.log(`diary seeded on CS/2026/041 (adjourned → next ${firmDate(2)})`);
}
if (createdCases.has("CRL/2026/107")) {
  await hearings.create(
    create(HearingSchema, {
      spec: { caseId: caseId("CRL/2026/107"), date: firmDate(6), purpose: "prosecution evidence" },
    }),
    asPartner,
  );
}
if (createdCases.has("ARB/2026/012")) {
  await hearings.create(
    create(HearingSchema, {
      spec: { caseId: caseId("ARB/2026/012"), date: firmDate(13), purpose: "claimant's opening" },
    }),
    asPartner,
  );
  await hearings.create(
    create(HearingSchema, {
      spec: { caseId: caseId("ARB/2026/012"), date: firmDate(-2), purpose: "procedural directions" },
    }),
    asPartner,
  );
  console.log("ARB/2026/012: one scheduled + one unrecorded past hearing (the nag fixture)");
}

/* Deadlines: one landing tomorrow, one already overdue — the escalation
 * ladder and the overdue surface both get honest data. */
if (createdCases.has("CS/2026/041")) {
  await deadlines.create(
    create(DeadlineSchema, {
      spec: {
        caseId: caseId("CS/2026/041"),
        title: "File amended written statement",
        dueDate: firmDate(1),
        statutoryBasis: "O.VIII R.1 CPC — time granted at the last hearing",
        ownerId: partnerMemberId,
      },
    }),
    asPartner,
  );
}
if (createdCases.has("ARB/2026/012")) {
  await deadlines.create(
    create(DeadlineSchema, {
      spec: {
        caseId: caseId("ARB/2026/012"),
        title: "Exchange of witness statements",
        dueDate: firmDate(-2),
        statutoryBasis: "Tribunal's procedural order no. 2",
        ownerId: partnerMemberId,
      },
    }),
    asPartner,
  );
}

/* Money: an agreed lump sum, part-received — the money glance shows a
 * real outstanding figure (₹1,50,000 charged, ₹50,000 received). */
if (createdCases.has("CS/2026/041")) {
  await fees.create(
    create(FeeArrangementSchema, {
      spec: {
        caseId: caseId("CS/2026/041"),
        feeKind: FeeKind.LUMP_SUM,
        lumpSumPaise: 15000000n,
      },
    }),
    asPartner,
  );
  await ledger.create(
    create(LedgerEntrySchema, {
      spec: {
        caseId: caseId("CS/2026/041"),
        entryKind: LedgerEntryKind.CHARGE,
        amountPaise: 15000000n,
        date: firmDate(-7),
        note: "Lump sum as agreed at engagement",
      },
    }),
    asPartner,
  );
  await ledger.create(
    create(LedgerEntrySchema, {
      spec: {
        caseId: caseId("CS/2026/041"),
        entryKind: LedgerEntryKind.RECEIPT,
        amountPaise: 5000000n,
        date: firmDate(-5),
        note: "Advance received by transfer",
      },
    }),
    asPartner,
  );
  console.log("money seeded on CS/2026/041 (₹1,50,000 charged, ₹50,000 received)");
}

/* Tasks: one overdue, one due today, one ahead — assignees are
 * FirmMember ids on the rebuilt contract. */
const SEED_TASKS = [
  {
    fileNumber: "CS/2026/041",
    title: "Brief senior counsel for the hearing",
    description: "Walk through the amended statement and exhibit list.",
    assigneeId: partnerMemberId,
    dueDate: firmDate(1),
    priority: TaskPriority.HIGH,
  },
  {
    fileNumber: "CRL/2026/107",
    title: "Collect certified order copies",
    description: "Registry counter; bring the filing receipt.",
    assigneeId: clerkMemberId,
    dueDate: firmDate(0),
    priority: TaskPriority.MEDIUM,
  },
  {
    fileNumber: "ARB/2026/012",
    title: "Index and paginate the claim bundle",
    description: "Three sets; tribunal copy spiral-bound.",
    assigneeId: clerkMemberId,
    dueDate: firmDate(-1),
    priority: TaskPriority.MEDIUM,
  },
];
for (const seed of SEED_TASKS) {
  if (!createdCases.has(seed.fileNumber)) continue;
  await tasks.create(
    create(TaskSchema, {
      spec: {
        caseId: caseId(seed.fileNumber),
        title: seed.title,
        description: seed.description,
        assigneeId: seed.assigneeId,
        dueDate: seed.dueDate,
        priority: seed.priority,
      },
    }),
    asPartner,
  );
  console.log(`task "${seed.title}" created (due ${seed.dueDate})`);
}

/* A note on the deep case. */
if (createdCases.has("CS/2026/041")) {
  await caseNotes.create(
    create(CaseNoteSchema, {
      spec: {
        caseId: caseId("CS/2026/041"),
        content:
          "Client called: opposing counsel likely to seek another adjournment; " +
          "judge previously insisted on the survey report being on record.",
      },
    }),
    asPartner,
  );
}

/* Documents (FR-DOC-001/003): a small fictional file room with REAL
 * text layers, so the document-intelligence demo beats work on seeded
 * data — search finds the limitation argument by page, the judgment
 * collection holds a citable award, and one deliberate "scan" (a
 * no-text page) shows the honest we-cannot-read-scans-yet answer.
 * The extraction sweep picks everything up within one tick of boot.
 * Gated on created-run cases like every non-keyed record (idempotency
 * note in the header). */
const SEED_DOCUMENTS: readonly {
  fileNumber: string;
  fileName: string;
  category: string;
  pages: readonly string[];
}[] = [
  {
    fileNumber: "CS/2026/041",
    fileName: "survey-report.pdf",
    category: "evidence",
    pages: ["Survey Report - CS/2026/041 - fictional demo document"],
  },
  {
    fileNumber: "CS/2026/041",
    fileName: "written-statement.pdf",
    category: "pleading",
    pages: [
      "WRITTEN STATEMENT of the defendant, fictional demo pleading. " +
        "PRELIMINARY OBJECTIONS: 1. The suit is barred by limitation under " +
        "Article 113 of the Limitation Act - the cause of action, if any, " +
        "arose more than three years before institution. 2. The plaint " +
        "discloses no cause of action against defendant no. 2.",
      "3. Without prejudice, the agreement dated 1 June 2024 contains an " +
        "arbitration clause covering every dispute raised in the plaint, and " +
        "the suit is liable to be referred under Section 8 of the " +
        "Arbitration and Conciliation Act. VERIFICATION: contents true to " +
        "knowledge, fictional demo document.",
    ],
  },
  {
    fileNumber: "ARB/2026/012",
    fileName: "meridian-v-silverline-award.pdf",
    category: "judgment",
    pages: [
      "FINAL AWARD, fictional demo arbitration. HELD: the arbitration " +
        "clause survives termination of the underlying contract; repudiation " +
        "of the agreement does not repudiate the agreement to arbitrate.",
      "On quantum: the claimant is awarded the invoiced sums with interest " +
        "at 9 percent per annum from the date of demand. Costs follow the " +
        "event. Fictional demo document.",
    ],
  },
  {
    fileNumber: "CRL/2026/107",
    fileName: "bail-order.pdf",
    category: "order_judgment",
    pages: [
      "ORDER on bail application, fictional demo order. Bail granted on a " +
        "personal bond of rupees fifty thousand with two sureties; passport " +
        "to be surrendered; the accused shall not contact prosecution " +
        "witnesses.",
    ],
  },
  {
    // The honesty fixture: a page with no text layer — the assistant
    // must say "a scan I can't read yet", never guess.
    fileNumber: "CRL/2026/107",
    fileName: "medical-records-scan.pdf",
    category: "evidence",
    pages: [""],
  },
];

for (const doc of SEED_DOCUMENTS) {
  // Documents seed onto EXISTING cases too — unlike the other
  // non-keyed records, the file room must be able to reach a firm
  // whose cases were seeded before document intelligence existed.
  // Idempotency is (case, file name): a name already on the case's
  // file skips.
  let matterId: string;
  try {
    matterId = (await cases.get({ fileNumber: doc.fileNumber }, asPartner)).metadata
      ?.id as string;
  } catch (err) {
    if (ConnectError.from(err).code === Code.NotFound) continue;
    throw err;
  }
  const onFile = await documents.list({ caseId: matterId, pageSize: 100 }, asPartner);
  if (onFile.items.some((d) => d.spec?.fileName === doc.fileName)) {
    console.log(`document ${doc.fileName} exists on ${doc.fileNumber} — skipping`);
    continue;
  }
  // The byte route is the ONLY non-Connect surface — exercised here the
  // way the web app uploads (raw POST, x-file-name header). Category
  // rides a header the same way the file name does.
  const res = await fetch(`${url}/files/cases/${matterId}/documents`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${login.accessToken}`,
      "content-type": "application/pdf",
      "x-file-name": encodeURIComponent(doc.fileName),
      "x-document-category": doc.category,
    },
    body: demoPdf(doc.pages),
  });
  if (res.status !== 201) {
    throw new Error(`document upload failed: ${res.status} ${await res.text()}`);
  }
  console.log(`document ${doc.fileName} (${doc.category}) uploaded to ${doc.fileNumber}`);
}

console.log("seed complete");

/** A minimal text-layer PDF, one text run per page, generated inline —
 * no binary fixture to carry. An empty string yields a textless page
 * (the "scan" fixture). */
function demoPdf(pages: readonly string[]): Buffer {
  const escape = (text: string) =>
    text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const kids = pages.map((_, i) => `${4 + 2 * i} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [i, text] of pages.entries()) {
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${escape(text)}) Tj ET` : "";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
