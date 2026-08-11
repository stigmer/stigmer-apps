/**
 * Account administration (DD-003 D4) — the managing partner's writes.
 * The server is the authority on every rule here (only the managing
 * partner passes, the lockout guards hold at the pipeline); these
 * mutations orchestrate and surface the server's own sentences.
 *
 * Onboarding is RESUMABLE BY NATURAL KEY: three server writes (account,
 * profile, code) cannot be atomic over the wire, so each step treats
 * ALREADY_EXISTS as "done earlier — continue". Running the form twice
 * with the same email finishes the onboarding instead of failing it.
 */

import { clone, create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApiClients } from "../../api/clients.js";
import {
  FirmMemberSchema,
  type FirmMember,
  type FirmRole,
} from "../../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import { UserSchema } from "../../gen/stigmer/identity/user/v1/user_pb.js";

/** A freshly issued activation code — shown exactly once. */
export interface IssuedActivation {
  readonly email: string;
  readonly code: string;
  readonly expiresInSeconds: number;
}

export interface OnboardMemberInput {
  readonly name: string;
  readonly email: string;
  /** E.164 (the WhatsApp binding); empty means no channel binding. */
  readonly phone: string;
  readonly role: FirmRole;
}

function isAlreadyExists(err: unknown): boolean {
  return ConnectError.from(err).code === Code.AlreadyExists;
}

export function useOnboardMember() {
  const { users, firmMembers } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    async mutationFn(input: OnboardMemberInput): Promise<IssuedActivation> {
      const email = input.email.trim().toLowerCase();

      let userId: string;
      try {
        const created = await users.create(
          create(UserSchema, {
            spec: {
              email,
              name: input.name.trim(),
              ...(input.phone.trim() ? { phone: input.phone.trim() } : {}),
            },
          }),
        );
        userId = created.metadata?.id ?? "";
      } catch (err) {
        if (!isAlreadyExists(err)) throw err;
        const existing = await users.get({ email });
        userId = existing.metadata?.id ?? "";
      }

      try {
        await firmMembers.create(create(FirmMemberSchema, { spec: { userId, role: input.role } }));
      } catch (err) {
        if (!isAlreadyExists(err)) throw err;
      }

      const issued = await users.issueActivationCode({ email });
      return { email, code: issued.code, expiresInSeconds: issued.expiresInSeconds };
    },
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ["members"] });
    },
  });
}

/** Reissue an activation code for an existing account (a reset: the
 * current password keeps working until the code is redeemed). */
export function useResetAccess() {
  const { users } = useApiClients();
  return useMutation({
    async mutationFn(email: string): Promise<IssuedActivation> {
      const issued = await users.issueActivationCode({ email });
      return { email, code: issued.code, expiresInSeconds: issued.expiresInSeconds };
    },
  });
}

/** Full-spec profile update (role change, deactivate, reactivate) — the
 * commons update convention: send the whole member back, changed. */
export function useUpdateMember() {
  const { firmMembers } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    async mutationFn(input: {
      member: FirmMember;
      changes: { role?: FirmRole; active?: boolean };
    }): Promise<FirmMember> {
      const next = clone(FirmMemberSchema, input.member);
      if (!next.spec) throw new Error("member carries no spec");
      if (input.changes.role !== undefined) next.spec.role = input.changes.role;
      if (input.changes.active !== undefined) next.spec.active = input.changes.active;
      return firmMembers.update(next);
    },
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ["members"] });
    },
  });
}
