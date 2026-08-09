/**
 * The case spec form — one component for both writes (FR-CASE-001 create,
 * FR-CASE-004 edit) because the contract's shape is one: full spec, all
 * fields editable, case number re-validated unique server-side
 * (ALREADY_EXISTS names the value; shown verbatim). Under D10 the form
 * always submits every spec field.
 */

import { useState, type FormEvent } from "react";
import { create } from "@bufbuild/protobuf";
import { ConnectError } from "@connectrpc/connect";
import {
  type CaseSpec,
  CaseSpecSchema,
} from "../../gen/stigmer/law/case/v1/case_pb.js";
import { useCurrentUser } from "../../session/use-session.js";
import { useUserDirectory } from "../users/queries.js";

export function CaseForm(props: {
  initial?: CaseSpec;
  submitLabel: string;
  pending: boolean;
  onSubmit: (spec: CaseSpec) => Promise<void>;
  onCancel: () => void;
}) {
  const me = useCurrentUser();
  const directory = useUserDirectory();

  const [caseNumber, setCaseNumber] = useState(props.initial?.caseNumber ?? "");
  const [clientName, setClientName] = useState(props.initial?.clientName ?? "");
  const [caseType, setCaseType] = useState(props.initial?.caseType ?? "");
  const [assignedLawyerId, setAssignedLawyerId] = useState(
    props.initial?.assignedLawyerId ?? me.metadata?.id ?? "",
  );
  const [nextHearingDate, setNextHearingDate] = useState(props.initial?.nextHearingDate ?? "");
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      await props.onSubmit(
        create(CaseSpecSchema, {
          caseNumber: caseNumber.trim(),
          clientName: clientName.trim(),
          caseType: caseType.trim(),
          assignedLawyerId,
          nextHearingDate: nextHearingDate || undefined,
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
      <label htmlFor="case-number" className={label}>
        Case number
      </label>
      <input
        id="case-number"
        required
        value={caseNumber}
        onChange={(e) => setCaseNumber(e.target.value)}
        placeholder="As issued by the court"
        className={field}
      />

      <label htmlFor="case-client" className={label}>
        Client name
      </label>
      <input
        id="case-client"
        required
        value={clientName}
        onChange={(e) => setClientName(e.target.value)}
        className={field}
      />

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

      <label htmlFor="case-lawyer" className={label}>
        Assigned lawyer
      </label>
      <select
        id="case-lawyer"
        required
        value={assignedLawyerId}
        onChange={(e) => setAssignedLawyerId(e.target.value)}
        className={field}
      >
        {directory.data?.users.map((u) => (
          <option key={u.metadata?.id} value={u.metadata?.id}>
            {u.spec?.name || u.spec?.email}
          </option>
        ))}
      </select>

      <label htmlFor="case-hearing" className={label}>
        Next hearing date <span className="font-normal text-ink-muted">(optional)</span>
      </label>
      <input
        id="case-hearing"
        type="date"
        value={nextHearingDate}
        onChange={(e) => setNextHearingDate(e.target.value)}
        className={field}
      />

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
