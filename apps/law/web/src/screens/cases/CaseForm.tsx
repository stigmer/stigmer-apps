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
import { Button } from "../../components/Button.js";
import { FormCard, FormError, InlineInput, Input, Label, Select } from "../../components/Field.js";
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

  return (
    <FormCard onSubmit={(e) => void onSubmit(e)} aria-label="Case details">
      <ClientPicker
        pickedName={props.initial ? props.initialClientName ?? "" : undefined}
        onPick={(client) => setClientId(client.metadata?.id ?? "")}
      />

      <Label htmlFor="case-file-number">File number</Label>
      <Input
        id="case-file-number"
        required
        value={fileNumber}
        onChange={(e) => setFileNumber(e.target.value)}
        placeholder="The firm's own number, e.g. CS/2026/042"
      />

      <Label htmlFor="case-client-role">Our client is the</Label>
      <Select
        id="case-client-role"
        required
        value={clientRole}
        onChange={(e) => setClientRole(Number(e.target.value) as ClientRole)}
      >
        <option value={ClientRole.UNSPECIFIED} disabled>
          Pick a role
        </option>
        {CLIENT_ROLES.map((role) => (
          <option key={role} value={role}>
            {clientRoleLabel(role)}
          </option>
        ))}
      </Select>

      <fieldset className="mb-4">
        <legend className="mb-1 text-sm font-medium">Opposing parties</legend>
        {opposingParties.map((party, index) => (
          <div key={index} className="mb-2 flex flex-wrap items-center gap-2">
            <label htmlFor={`opposing-name-${index}`} className="sr-only">
              Opposing party {index + 1} name
            </label>
            <InlineInput
              id={`opposing-name-${index}`}
              value={party.name}
              onChange={(e) => setParty(index, { name: e.target.value })}
              placeholder="Party name"
              className="flex-1 basis-48"
            />
            <label htmlFor={`opposing-counsel-${index}`} className="sr-only">
              Opposing party {index + 1} counsel
            </label>
            <InlineInput
              id={`opposing-counsel-${index}`}
              value={party.counselName}
              onChange={(e) => setParty(index, { counselName: e.target.value })}
              placeholder="Their counsel (if known)"
              className="flex-1 basis-48"
            />
            {opposingParties.length > 1 && (
              <Button
                variant="danger"
                onClick={() =>
                  setOpposingParties((parties) => parties.filter((_, i) => i !== index))
                }
                aria-label={`Remove opposing party ${index + 1}`}
              >
                Remove
              </Button>
            )}
          </div>
        ))}
        <Button
          onClick={() =>
            setOpposingParties((parties) => [...parties, { name: "", counselName: "" }])
          }
        >
          Add another party
        </Button>
      </fieldset>

      <Label htmlFor="case-forum-kind">Forum</Label>
      <Select
        id="case-forum-kind"
        required
        value={forumKind}
        onChange={(e) => setForumKind(Number(e.target.value) as ForumKind)}
      >
        <option value={ForumKind.UNSPECIFIED} disabled>
          Pick a forum
        </option>
        {FORUM_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {forumKindLabel(kind)}
          </option>
        ))}
      </Select>

      <Label htmlFor="case-forum-name">Court or forum name</Label>
      <Input
        id="case-forum-name"
        required
        value={forumName}
        onChange={(e) => setForumName(e.target.value)}
        placeholder="As the cause list prints it"
      />

      <Label htmlFor="case-bench">
        Bench <span className="font-normal text-ink-muted">(optional)</span>
      </Label>
      <Input id="case-bench" value={bench} onChange={(e) => setBench(e.target.value)} />

      <Label htmlFor="case-type">Case type</Label>
      <Input
        id="case-type"
        required
        value={caseType}
        onChange={(e) => setCaseType(e.target.value)}
        placeholder="civil, criminal, writ…"
      />

      <Label htmlFor="case-stage">
        Stage <span className="font-normal text-ink-muted">(optional)</span>
      </Label>
      <Input
        id="case-stage"
        value={stage}
        onChange={(e) => setStage(e.target.value)}
        placeholder="admission, evidence, arguments…"
      />

      <Label htmlFor="case-lead">Lead lawyer</Label>
      <Select
        id="case-lead"
        required
        value={effectiveLead}
        onChange={(e) => setLeadLawyerId(e.target.value)}
      >
        {roster.data?.members
          .filter((member) => LEAD_ROLES.includes(member.spec?.role ?? FirmRole.UNSPECIFIED))
          .map((member) => (
            <option key={member.metadata?.id} value={member.metadata?.id}>
              {member.status?.userName || member.status?.userEmail}
            </option>
          ))}
      </Select>

      <Label htmlFor="case-court-number">
        Court case number <span className="font-normal text-ink-muted">(optional, once filed)</span>
      </Label>
      <Input
        id="case-court-number"
        value={courtCaseNumber}
        onChange={(e) => setCourtCaseNumber(e.target.value)}
      />

      <Label htmlFor="case-cnr">
        CNR <span className="font-normal text-ink-muted">(optional)</span>
      </Label>
      <Input id="case-cnr" value={cnr} onChange={(e) => setCnr(e.target.value)} />

      <FormError message={error} />

      <div className="flex gap-3">
        <Button type="submit" variant="primary" disabled={props.pending}>
          {props.pending ? "Saving…" : props.submitLabel}
        </Button>
        <Button onClick={props.onCancel}>Cancel</Button>
      </div>
    </FormCard>
  );
}
