/**
 * Demo-firm seeding — the committed instrument that puts a fictional,
 * demo-ready dataset onto a DEPLOYED firm through the product's own
 * surfaces (the mcp-smoke.ts practice: a deploy is accepted by running a
 * committed script against it, never by hand-typed calls that cannot be
 * repeated). Everything runs over the wire: users are corrected through
 * the operator path, records are created AS a signed-in staff member so
 * audit fields read exactly like production rows. No store writes, ever.
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
 * Idempotency: cases are keyed by their court case number, so re-running
 * skips ones that exist. Tasks, notes, and the document have no natural
 * key — they are seeded ONLY when their case was created by this run,
 * so a re-run never duplicates them. To re-seed from scratch, reset the
 * firm's database first.
 */

import { create } from "@bufbuild/protobuf";
import { createClient, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { AuthService, UserSchema, UserService, type User } from "@stigmer/identity";
import { Code, ConnectError } from "@connectrpc/connect";
import { CaseSchema, CaseService, type Case } from "../src/gen/stigmer/law/case/v1/case_pb.js";
import { CaseNoteSchema, CaseNoteService } from "../src/gen/stigmer/law/casenote/v1/casenote_pb.js";
import {
  TaskPriority,
  TaskSchema,
  TaskService,
} from "../src/gen/stigmer/law/task/v1/task_pb.js";

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
const cases = createClient(CaseService, transport);
const tasks = createClient(TaskService, transport);
const caseNotes = createClient(CaseNoteService, transport);

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

if (partnerPhone) await bindPhone(partnerEmail, partnerPhone);
if (clerkPhone) await bindPhone(clerkEmail, clerkPhone);

// Everything below is created AS THE PARTNER — a real login, so every
// record's createdBy is a person, exactly like production data entry.
const login = await auth.login({ email: partnerEmail, password: partnerPassword });
const asPartner = { headers: { authorization: `Bearer ${login.accessToken}` } };

const partner = await users.get({ email: partnerEmail }, asPartner);
const clerk = await users.get({ email: clerkEmail }, asPartner);
const partnerId = partner.metadata?.id as string;
const clerkId = clerk.metadata?.id as string;

/* ------------------------------------------------------------------ */
/* The dataset (fictional by construction)                             */
/* ------------------------------------------------------------------ */

// Hearing dates spread over the demo's two-week horizon; one case is
// deliberately unscheduled so firm_overview's "no hearing scheduled"
// line has something honest to report.
const SEED_CASES: {
  caseNumber: string;
  clientName: string;
  caseType: string;
  assignedLawyerId: string;
  nextHearingDate?: string;
}[] = [
  {
    caseNumber: "CS/2026/041",
    clientName: "Meridian Textiles Pvt Ltd",
    caseType: "civil",
    assignedLawyerId: partnerId,
    nextHearingDate: firmDate(2),
  },
  {
    caseNumber: "CRL/2026/107",
    clientName: "S. Raghavan",
    caseType: "criminal",
    assignedLawyerId: partnerId,
    nextHearingDate: firmDate(6),
  },
  {
    caseNumber: "ARB/2026/012",
    clientName: "Blue Harbour Logistics",
    caseType: "arbitration",
    assignedLawyerId: partnerId,
    nextHearingDate: firmDate(13),
  },
  {
    caseNumber: "WP/2026/220",
    clientName: "Kavya Menon",
    caseType: "writ petition",
    assignedLawyerId: partnerId,
    // No hearing scheduled — the matters-needing-attention fixture.
  },
];

// Tasks keyed to their case: one overdue, one due today, the rest ahead
// — my_open_tasks, find_tasks(clerk), and the OVERDUE filter all get
// real answers.
const SEED_TASKS: {
  caseNumber: string;
  title: string;
  description: string;
  assigneeId: string;
  dueDate?: string;
  priority: TaskPriority;
}[] = [
  {
    caseNumber: "CS/2026/041",
    title: "File amended written statement",
    description: "Incorporate the survey report annexures before filing.",
    assigneeId: clerkId,
    dueDate: firmDate(-1),
    priority: TaskPriority.HIGH,
  },
  {
    caseNumber: "CS/2026/041",
    title: "Brief senior counsel for the hearing",
    description: "Walk through the amended statement and exhibit list.",
    assigneeId: partnerId,
    dueDate: firmDate(1),
    priority: TaskPriority.MEDIUM,
  },
  {
    caseNumber: "CRL/2026/107",
    title: "Collect certified order copies",
    description: "Registry counter; bring the filing receipt.",
    assigneeId: clerkId,
    dueDate: firmDate(0),
    priority: TaskPriority.MEDIUM,
  },
  {
    caseNumber: "ARB/2026/012",
    title: "Index and paginate the claim bundle",
    description: "Three sets; tribunal copy spiral-bound.",
    assigneeId: clerkId,
    dueDate: firmDate(5),
    priority: TaskPriority.LOW,
  },
];

const SEED_NOTE = {
  caseNumber: "CS/2026/041",
  content:
    "Client called: opposing counsel likely to seek adjournment; " +
    "judge previously insisted on the survey report being on record.",
};

/** A minimal one-page PDF, generated inline — no binary fixture to carry. */
function tinyPdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
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

/* ------------------------------------------------------------------ */
/* Seed                                                                */
/* ------------------------------------------------------------------ */

const createdCases = new Map<string, Case>();

for (const seed of SEED_CASES) {
  try {
    const existing = await cases.get({ caseNumber: seed.caseNumber }, asPartner);
    console.log(`case ${seed.caseNumber} exists (id ${existing.metadata?.id}) — skipping it and its records`);
    continue;
  } catch (err) {
    if (ConnectError.from(err).code !== Code.NotFound) throw err;
  }
  const created = await cases.create(create(CaseSchema, { spec: seed }), asPartner);
  createdCases.set(seed.caseNumber, created);
  console.log(`case ${seed.caseNumber} created (${seed.nextHearingDate ?? "no hearing scheduled"})`);
}

for (const seed of SEED_TASKS) {
  const parent = createdCases.get(seed.caseNumber);
  if (!parent) continue;
  await tasks.create(
    create(TaskSchema, {
      spec: {
        caseId: parent.metadata?.id as string,
        title: seed.title,
        description: seed.description,
        assigneeId: seed.assigneeId,
        dueDate: seed.dueDate,
        priority: seed.priority,
      },
    }),
    asPartner,
  );
  console.log(`task "${seed.title}" created (due ${seed.dueDate ?? "—"})`);
}

const noteCase = createdCases.get(SEED_NOTE.caseNumber);
if (noteCase) {
  await caseNotes.create(
    create(CaseNoteSchema, {
      spec: { caseId: noteCase.metadata?.id as string, content: SEED_NOTE.content },
    }),
    asPartner,
  );
  console.log(`note added to ${SEED_NOTE.caseNumber}`);

  // The byte route is the ONLY non-Connect surface — exercised here the
  // way the web app uploads (raw POST, x-file-name header).
  const pdf = tinyPdf("Survey Report - CS/2026/041 (fictional demo document)");
  const res = await fetch(`${url}/files/cases/${noteCase.metadata?.id}/documents`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${login.accessToken}`,
      "content-type": "application/pdf",
      "x-file-name": encodeURIComponent("survey-report.pdf"),
    },
    body: pdf,
  });
  if (res.status !== 201) {
    throw new Error(`document upload failed: ${res.status} ${await res.text()}`);
  }
  console.log(`document survey-report.pdf uploaded to ${SEED_NOTE.caseNumber}`);
}

console.log("seed complete");
