/**
 * The Guide: the product's own explanation of itself, for the people
 * who run their working day through it. It answers the three questions
 * a firm actually asks — who can see what (the role matrix, in plain
 * words, with the reader's own role marked), how the day's records
 * work, and what the assistant can and cannot do.
 *
 * Two consistency contracts hold this page together:
 *   1. the role rows render from ROLE_GUIDE, whose coverage of the
 *      FirmRole enum is compile-time checked (role-guide.ts);
 *   2. every capability claim about the assistant is written FROM the
 *      agent template's instructions (apps/law/deploy/stigmer/
 *      agent.yaml) — the assistant's self-description and this page
 *      must never disagree, so neither invents its own wording.
 *
 * Static by design: no queries beyond the caller's own role (already
 * cached beside the session), so the page renders instantly and works
 * as the thing a partner opens mid-conversation to answer "who can
 * see the fees?".
 */

import type { ReactNode } from "react";
import { Badge } from "../../components/Badge.js";
import { PageHeader } from "../../components/PageHeader.js";
import { SectionCard } from "../../components/SectionCard.js";
import { firmRoleLabel } from "../../lib/format.js";
import { useMyRole } from "../../session/use-firm-member.js";
import { GUIDE_ROLES, ROLE_GUIDE } from "./role-guide.js";

function Prose(props: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed">{props.children}</p>;
}

function ProseList(props: { children: ReactNode }) {
  return <ul className="grid list-disc gap-1.5 pl-5 text-sm leading-relaxed">{props.children}</ul>;
}

export function GuideScreen() {
  // While the role resolves the table simply renders unhighlighted —
  // a static page never shows a spinner for one badge.
  const myRole = useMyRole();

  return (
    <div className="grid gap-4">
      <PageHeader title="Guide" />
      <p className="-mt-2 text-sm text-ink-muted">
        How this system works, who can see what, and what the assistant can do.
      </p>

      <SectionCard title="This system">
        <Prose>
          This is your firm&apos;s case system. Every matter, hearing, deadline, task, note,
          document, and fee lives here — one record everyone works from. You reach it two ways:
          this web app at a desk, and the firm&apos;s assistant on WhatsApp when you are out. Both
          show the same record; anything captured in one place appears in the other.
        </Prose>
      </SectionCard>

      <SectionCard title="Who can do what">
        <Prose>
          Everyone signs in as themselves and holds one role in the firm. Your role decides what
          you can see and do — the system enforces this on every request, whether it comes from a
          screen or from the assistant.
        </Prose>
        <ul className="mt-3 grid gap-3">
          {GUIDE_ROLES.map((role) => (
            <li key={role} className="border-t border-line pt-3 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{firmRoleLabel(role)}</span>
                {role === myRole && <Badge tone="brand">Your role</Badge>}
              </div>
              <p className="mt-0.5 text-sm leading-relaxed text-ink-muted">
                {ROLE_GUIDE[role].summary}
              </p>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm leading-relaxed">
          When something is outside your role, the system refuses and says why. The assistant
          gives the same refusal in the same words — there is one rulebook, checked at every door.
        </p>
      </SectionCard>

      <SectionCard title="The working day">
        <ProseList>
          <li>
            <strong>Matters</strong> are opened against the client register. The register&apos;s
            search box is also the conflict check: it finds matching clients and matters where
            that name is on the other side.
          </li>
          <li>
            <strong>The diary</strong> is the heart of a matter. When a hearing happens, record
            what happened; if the court gave a next date, the next hearing goes on the board by
            itself. A recorded outcome is permanent — it is the firm&apos;s record of what the
            court did.
          </li>
          <li>
            <strong>Deadlines</strong> carry their due date and, where there is one, the rule they
            come from. Overdue ones are flagged until they are done.
          </li>
          <li>
            <strong>Tasks</strong> are assigned work with a due date. The person assigned sees
            them on their board and in their inbox.
          </li>
        </ProseList>
      </SectionCard>

      <SectionCard title="Documents">
        <ProseList>
          <li>
            File a paper from the matter&apos;s Documents tab — two clicks. It is stored
            privately; only people on the matter (and partners) can open it.
          </li>
          <li>
            Or file it through the assistant: send the paper in the conversation (a WhatsApp
            photo, an attachment in Ask AI) and ask for it to be filed. The assistant confirms
            the matter, the file name, and the category before it writes.
          </li>
          <li>
            The assistant can list what is on file, search the text of documents across every
            matter you can see, and read them back to you. When it quotes a document, it names the
            document and the page.
          </li>
          <li>
            The Library is the firm&apos;s citation shelf: judgments the firm relies on,
            uploaded there directly — no matter needed — plus every judgment filed on a
            matter. Each citation carries where it has been used and for what proposition.
          </li>
          <li>
            Scanned papers and photos are read automatically where scan reading is set up for the
            firm — it takes a few minutes after upload. The assistant and search say honestly, per
            document, what can and cannot be read.
          </li>
        </ProseList>
      </SectionCard>

      <SectionCard title="The assistant">
        <Prose>
          The firm&apos;s assistant answers on WhatsApp and in this app&apos;s Ask AI panel. It
          knows who you are: WhatsApp verifies your number, the web app your sign-in. It answers
          only from the firm&apos;s records, only what your role allows.
        </Prose>
        <h3 className="mt-3 mb-1 text-sm font-medium">What it can do</h3>
        <ProseList>
          <li>
            Answer &ldquo;what&apos;s my day&rdquo;, a matter&apos;s story so far, upcoming
            hearings, deadlines, and (for partners) outstanding balances.
          </li>
          <li>
            Answer &ldquo;what happened today?&rdquo; — outcomes recorded today with their next
            dates, new hearings on the board, new deadlines, and open tasks still waiting for an
            owner.
          </li>
          <li>
            Record a hearing outcome, update a task, or add a case note — it reads the entry back
            and waits for your yes before writing.
          </li>
          <li>Find, search, and read the documents on file, quoting the page.</li>
          <li>
            Answer &ldquo;which acts apply here?&rdquo; from the matter&apos;s own filed papers
            (the FIR, the charge sheet), quoting the page — never from its own general
            knowledge. Record that a judgment was used in a matter, and answer &ldquo;find me a
            citation for X&rdquo; from the firm&apos;s own library — presenting candidates with
            their document, page, and past uses for you to judge.
          </li>
          <li>
            File a paper you send it — a photo of a court order on WhatsApp, an attachment in
            Ask AI — into the matter&apos;s case file, after confirming the matter and the
            category with you.
          </li>
        </ProseList>
        <h3 className="mt-3 mb-1 text-sm font-medium">What it cannot do yet</h3>
        <ProseList>
          <li>
            Reading a scan is never perfect — text read from a scan is marked, and may contain
            recognition errors.
          </li>
          <li>It does not give legal advice, predict outcomes, or draft legal documents.</li>
        </ProseList>
      </SectionCard>

      <SectionCard title="Joining the firm">
        <ProseList>
          <li>
            The managing partner adds you as a member and hands you a one-time activation code —
            in person or on WhatsApp. Open the app&apos;s activation page, enter the code, and set
            your own password. The code works once and expires.
          </li>
          <li>
            You can change your password any time from your profile. If you are locked out, the
            managing partner issues a fresh activation code.
          </li>
        </ProseList>
      </SectionCard>
    </div>
  );
}
