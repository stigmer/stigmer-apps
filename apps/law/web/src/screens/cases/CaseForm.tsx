/**
 * The case spec form — one component for both writes (intake create,
 * detail edit) because the contract's shape is one: full-spec
 * replacement, so EVERY spec field appears here even when rarely touched
 * (court case number, CNR) — omitting one would blank it on edit. The
 * file number is re-validated unique server-side (ALREADY_EXISTS names
 * the value; shown verbatim). Lifecycle is NOT here: UpdateStatus is its
 * only write path.
 */

import { useState, type FormEvent } from "react";
import { create } from "@bufbuild/protobuf";
import { ConnectError } from "@connectrpc/connect";
import {
  ClientRole,
  ForumKind,
  type CaseSpec,
  CaseSpecSchema,
} from "../../gen/stigmer/law/case/v1/case_pb.js";
import { FirmRole } from "../../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import { clientRoleLabel, forumKindLabel } from "../../lib/format.js";
import { useFirmMember } from "../../session/use-firm-member.js";
import { useFirmRoster } from "../members/queries.js";
import { ClientPicker } from "./ClientPicker.js";

const CLIENT_ROLES: readonly ClientRole[] = [
  ClientRole.PLAINTIFF,
  ClientRole.DEFENDANT,
  ClientRole.PETITIONER,
  ClientRole.RESPONDENT,
  ClientRole.COMPLAINANT,
  ClientRole.ACCUSED,
  ClientRole.APPELLANT,
  ClientRole.OTHER,
];

const FORUM_KINDS: readonly ForumKind[] = [
  ForumKind.DISTRICT_COURT,
  ForumKind.HIGH_COURT,
  ForumKind.NCLT,
  ForumKind.DRT,
  ForumKind.CONSUMER_FORUM,
  ForumKind.OTHER,
];

/** Only lawyers lead matters — the roster narrowed for the lead picker. */
const LEAD_ROLES: readonly FirmRole[] = [
  FirmRole.MANAGING_PARTNER,
  FirmRole.PARTNER,
  FirmRole.ASSOCIATE,
  FirmRole.JUNIOR,
];

interface OpposingPartyDraft {
  name: string;
  counselName: string;
}

export function CaseForm(props: {
  initial?: CaseSpec;
  /** The picked client's display name when editing (spec carries only the id). */
  initialClientName?: string;
  submitLabel: string;
  pending: boolean;
  onSubmit: (spec: CaseSpec) => Promise<void>;
  onCancel: () => void;
}) {
  const me = useFirmMember();
  const roster = useFirmRoster();

  const [clientId, setClientId] = useState(props.initial?.clientId ?? "");
  const [fileNumber, setFileNumber] = useState(props.initial?.fileNumber ?? "");
  const [clientRole, setClientRole] = useState<ClientRole>(
    props.initial?.clientRole ?? ClientRole.UNSPECIFIED,
  );
  const [opposingParties, setOpposingParties] = useState<OpposingPartyDraft[]>(
    props.initial?.opposingParties.map((p) => ({ name: p.name, counselName: p.counselName })) ?? [
      { name: "", counselName: "" },
    ],
  );
  const [forumKind, setForumKind] = useState<ForumKind>(
    props.initial?.forum?.forumKind ?? ForumKind.UNSPECIFIED,
  );
  const [forumName, setForumName] = useState(props.initial?.forum?.name ?? "");
  const [bench, setBench] = useState(props.initial?.forum?.bench ?? "");
  const [caseType, setCaseType] = useState(props.initial?.caseType ?? "");
  const [stage, setStage] = useState(props.initial?.stage ?? "");
  const [leadLawyerId, setLeadLawyerId] = useState(props.initial?.leadLawyerId ?? "");
  const [courtCaseNumber, setCourtCaseNumber] = useState(props.initial?.courtCaseNumber ?? "");
  const [cnr, setCnr] = useState(props.initial?.cnr ?? "");
  const [error, setError] = useState<string | undefined>();

  // Intake defaults the lead to the person opening the matter, once
  // their profile resolves — a picker most users never need to touch.
  const effectiveLead = leadLawyerId || me.data?.metadata?.id || "";

  function setParty(index: number, patch: Partial<OpposingPartyDraft>) {
    setOpposingParties((parties) =>
      parties.map((party, i) => (i === index ? { ...party, ...patch } : party)),
    );
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    if (!clientId) {
      setError("Pick the client this matter is for — or add them as a new client.");
      return;
    }
    try {
      await props.onSubmit(
        create(CaseSpecSchema, {
          fileNumber: fileNumber.trim(),
          clientId,
          clientRole,
          opposingParties: opposingParties
            .filter((party) => party.name.trim() !== "")
            .map((party) => ({
              name: party.name.trim(),
              counselName: party.counselName.trim(),
            })),
          forum: {
            forumKind,
            name: forumName.trim(),
            bench: bench.trim() || undefined,
          },
          caseType: caseType.trim(),
          stage: stage.trim(),
          leadLawyerId: effectiveLead,
          courtCaseNumber: courtCaseNumber.trim() || undefined,
          cnr: cnr.trim() || undefined,
        }),
      );
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  const field = "mb-4 block h-11 w-full rounded-card border border-line bg-surface px-3";
  const label = "mb-1 block text-sm font-medium";

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      aria-label="Case details"
      className="rounded-card border border-line bg-surface p-6"
    >
      <ClientPicker
        pickedName={props.initial ? props.initialClientName ?? "" : undefined}
        onPick={(client) => setClientId(client.metadata?.id ?? "")}
      />

      <label htmlFor="case-file-number" className={label}>
        File number
      </label>
      <input
        id="case-file-number"
        required
        value={fileNumber}
        onChange={(e) => setFileNumber(e.target.value)}
        placeholder="The firm's own number, e.g. CS/2026/042"
        className={field}
      />

      <label htmlFor="case-client-role" className={label}>
        Our client is the
      </label>
      <select
        id="case-client-role"
        required
        value={clientRole}
        onChange={(e) => setClientRole(Number(e.target.value) as ClientRole)}
        className={field}
      >
        <option value={ClientRole.UNSPECIFIED} disabled>
          Pick a role
        </option>
        {CLIENT_ROLES.map((role) => (
          <option key={role} value={role}>
            {clientRoleLabel(role)}
          </option>
        ))}
      </select>

      <fieldset className="mb-4">
        <legend className="mb-1 text-sm font-medium">Opposing parties</legend>
        {opposingParties.map((party, index) => (
          <div key={index} className="mb-2 flex flex-wrap items-center gap-2">
            <label htmlFor={`opposing-name-${index}`} className="sr-only">
              Opposing party {index + 1} name
            </label>
            <input
              id={`opposing-name-${index}`}
              value={party.name}
              onChange={(e) => setParty(index, { name: e.target.value })}
              placeholder="Party name"
              className="block h-11 flex-1 basis-48 rounded-card border border-line bg-surface px-3"
            />
            <label htmlFor={`opposing-counsel-${index}`} className="sr-only">
              Opposing party {index + 1} counsel
            </label>
            <input
              id={`opposing-counsel-${index}`}
              value={party.counselName}
              onChange={(e) => setParty(index, { counselName: e.target.value })}
              placeholder="Their counsel (if known)"
              className="block h-11 flex-1 basis-48 rounded-card border border-line bg-surface px-3"
            />
            {opposingParties.length > 1 && (
              <button
                type="button"
                onClick={() =>
                  setOpposingParties((parties) => parties.filter((_, i) => i !== index))
                }
                aria-label={`Remove opposing party ${index + 1}`}
                className="h-11 rounded-card px-3 text-sm text-danger hover:bg-danger-surface"
              >
                Remove
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            setOpposingParties((parties) => [...parties, { name: "", counselName: "" }])
          }
          className="h-11 rounded-card px-3 text-sm text-brand hover:bg-brand-surface"
        >
          Add another party
        </button>
      </fieldset>

      <label htmlFor="case-forum-kind" className={label}>
        Forum
      </label>
      <select
        id="case-forum-kind"
        required
        value={forumKind}
        onChange={(e) => setForumKind(Number(e.target.value) as ForumKind)}
        className={field}
      >
        <option value={ForumKind.UNSPECIFIED} disabled>
          Pick a forum
        </option>
        {FORUM_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {forumKindLabel(kind)}
          </option>
        ))}
      </select>

      <label htmlFor="case-forum-name" className={label}>
        Court or forum name
      </label>
      <input
        id="case-forum-name"
        required
        value={forumName}
        onChange={(e) => setForumName(e.target.value)}
        placeholder="As the cause list prints it"
        className={field}
      />

      <label htmlFor="case-bench" className={label}>
        Bench <span className="font-normal text-ink-muted">(optional)</span>
      </label>
      <input id="case-bench" value={bench} onChange={(e) => setBench(e.target.value)} className={field} />

      <label htmlFor="case-type" className={label}>
        Case type
      </label>
      <input
        id="case-type"
        required
        value={caseType}
        onChange={(e) => setCaseType(e.target.value)}
        placeholder="civil, criminal, writ…"
        className={field}
      />

      <label htmlFor="case-stage" className={label}>
        Stage <span className="font-normal text-ink-muted">(optional)</span>
      </label>
      <input
        id="case-stage"
        value={stage}
        onChange={(e) => setStage(e.target.value)}
        placeholder="admission, evidence, arguments…"
        className={field}
      />

      <label htmlFor="case-lead" className={label}>
        Lead lawyer
      </label>
      <select
        id="case-lead"
        required
        value={effectiveLead}
        onChange={(e) => setLeadLawyerId(e.target.value)}
        className={field}
      >
        {roster.data?.members
          .filter((member) => LEAD_ROLES.includes(member.spec?.role ?? FirmRole.UNSPECIFIED))
          .map((member) => (
            <option key={member.metadata?.id} value={member.metadata?.id}>
              {member.status?.userName || member.status?.userEmail}
            </option>
          ))}
      </select>

      <label htmlFor="case-court-number" className={label}>
        Court case number <span className="font-normal text-ink-muted">(optional, once filed)</span>
      </label>
      <input
        id="case-court-number"
        value={courtCaseNumber}
        onChange={(e) => setCourtCaseNumber(e.target.value)}
        className={field}
      />

      <label htmlFor="case-cnr" className={label}>
        CNR <span className="font-normal text-ink-muted">(optional)</span>
      </label>
      <input id="case-cnr" value={cnr} onChange={(e) => setCnr(e.target.value)} className={field} />

      {error && (
        <p role="alert" className="mb-4 rounded-card bg-danger-surface px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={props.pending}
          className="h-11 rounded-card bg-brand px-4 font-medium text-on-brand hover:bg-brand-strong disabled:opacity-60"
        >
          {props.pending ? "Saving…" : props.submitLabel}
        </button>
        <button
          type="button"
          onClick={props.onCancel}
          className="h-11 rounded-card px-4 text-brand hover:bg-brand-surface"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
