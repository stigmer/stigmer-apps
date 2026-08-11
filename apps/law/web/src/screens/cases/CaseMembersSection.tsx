/**
 * The matter's working team (FR-CASE-003): who may see and work this
 * case's content. Partners and the lead manage the set; the server
 * enforces that (and refuses removing the current lead) — its sentences
 * render verbatim.
 */

import { useState, type FormEvent } from "react";
import { ConnectError } from "@connectrpc/connect";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Badge } from "../../components/Badge.js";
import { Button } from "../../components/Button.js";
import { FormError, InlineSelect, Label } from "../../components/Field.js";
import { RoleOnCase } from "../../gen/stigmer/law/casemember/v1/casemember_pb.js";
import { firmRoleLabel } from "../../lib/format.js";
import { FirmRole } from "../../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import { useFirmRoster } from "../members/queries.js";
import { useAddCaseMember, useCaseMembers, useRemoveCaseMember } from "./queries.js";

export function CaseMembersSection(props: { caseId: string; leadMemberId: string }) {
  const members = useCaseMembers(props.caseId);
  const roster = useFirmRoster();
  const addMember = useAddCaseMember(props.caseId);
  const removeMember = useRemoveCaseMember(props.caseId);
  const [adding, setAdding] = useState(false);
  const [pickedId, setPickedId] = useState("");
  const [error, setError] = useState<string | undefined>();

  const currentIds = new Set(members.data?.items.map((m) => m.spec?.memberId) ?? []);
  const addable = (roster.data?.members ?? []).filter(
    (member) => !currentIds.has(member.metadata?.id),
  );

  async function onAdd(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    const picked = roster.data?.members.find((m) => m.metadata?.id === pickedId);
    try {
      await addMember.mutateAsync({
        memberId: pickedId,
        // Clerks join as clerks; everyone else works as a lawyer.
        roleOnCase:
          picked?.spec?.role === FirmRole.CLERK ? RoleOnCase.CLERK : RoleOnCase.LAWYER,
      });
      setPickedId("");
      setAdding(false);
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  async function onRemove(membershipId: string) {
    setError(undefined);
    try {
      await removeMember.mutateAsync(membershipId);
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  return (
    <section aria-label="Working team" className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Working team</h2>
        <Button onClick={() => setAdding((v) => !v)}>
          {adding ? "Close" : "Add someone"}
        </Button>
      </div>

      {adding && (
        <form
          onSubmit={(e) => void onAdd(e)}
          aria-label="Add to the working team"
          className="mb-3 flex flex-wrap items-end gap-2 rounded-card border border-line bg-surface p-3"
        >
          <div className="min-w-48 flex-1">
            <Label htmlFor="member-pick">Who</Label>
            <InlineSelect
              id="member-pick"
              required
              value={pickedId}
              onChange={(e) => setPickedId(e.target.value)}
              className="block w-full"
            >
              <option value="" disabled>
                Pick a colleague
              </option>
              {addable.map((member) => (
                <option key={member.metadata?.id} value={member.metadata?.id}>
                  {member.status?.userName || member.status?.userEmail} —{" "}
                  {firmRoleLabel(member.spec?.role ?? FirmRole.UNSPECIFIED)}
                </option>
              ))}
            </InlineSelect>
          </div>
          <Button type="submit" variant="primary" disabled={addMember.isPending}>
            {addMember.isPending ? "Adding…" : "Add"}
          </Button>
        </form>
      )}

      <FormError message={error} />

      {members.isPending && <Loading label="Loading the team…" />}
      {members.isError && (
        <ErrorState error={members.error} onRetry={() => void members.refetch()} />
      )}
      {members.isSuccess && members.data.items.length === 0 && (
        <EmptyState title="Nobody on this matter yet" />
      )}
      {members.isSuccess && members.data.items.length > 0 && (
        <ul className="rounded-card border border-line bg-surface">
          {members.data.items.map((membership) => {
            const memberId = membership.spec?.memberId ?? "";
            const isLead = memberId === props.leadMemberId;
            return (
              <li
                key={membership.metadata?.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5 last:border-b-0"
              >
                <span className="font-medium">{roster.data?.nameOf(memberId) ?? memberId}</span>
                <span className="text-xs text-ink-muted">
                  {membership.spec?.roleOnCase === RoleOnCase.CLERK ? "Clerk" : "Lawyer"}
                </span>
                {isLead && <Badge>Lead</Badge>}
                {!isLead && (
                  <span className="ml-auto">
                    <Button
                      variant="danger"
                      onClick={() => void onRemove(membership.metadata?.id ?? "")}
                      disabled={removeMember.isPending}
                    >
                      Remove
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
