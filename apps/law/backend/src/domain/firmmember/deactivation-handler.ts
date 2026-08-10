/**
 * FR-MEMBER-002's session lever: deactivating a firm member revokes
 * their refresh sessions through the identity seam — the same revocation
 * SetPassword performs (DD-005 D9). Belt and braces by design: the
 * policy already denies a deactivated member on their next request
 * (access tokens live ≤1h), so a lost event here degrades to "locked
 * out at the policy, refresh dies within the hour", never to access.
 *
 * Idempotent trivially: revoking an already-empty session set is a
 * no-op, so duplicate delivery costs nothing.
 */

import type { InProcessEventDispatcher } from "@stigmer/resource-api";
import type { RefreshTokenStore } from "@stigmer/identity";
import type { FirmMember } from "../../gen/stigmer/law/firmmember/v1/firmmember_pb.js";

export function registerDeactivationHandler(
  dispatcher: InProcessEventDispatcher,
  refreshTokens: RefreshTokenStore,
): void {
  dispatcher.subscribe("FirmMember", async (event) => {
    const member = event.resource as FirmMember;
    const previous = event.previous as FirmMember | undefined;

    // Only the transition matters: an update that leaves an already-
    // inactive member inactive has no sessions left to kill.
    const wasActive = previous?.spec?.active !== false;
    const isInactive = member.spec?.active === false;
    if (!wasActive || !isInactive) return;

    const userId = member.spec?.userId;
    if (!userId) return;
    await refreshTokens.revokeAllForUser(userId);
  });
}
