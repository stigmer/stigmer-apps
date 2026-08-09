/**
 * Channel identity resolution (T05): a messaging-channel-verified sender
 * identity (e.g. a WhatsApp wa_id, verified by Meta and asserted by the
 * agent platform) resolved to a user-kind CallerPrincipal by exact phone
 * match against the User store.
 *
 * Deliberately NOT an `Authenticator` in the app's chain — this is a
 * recorded correction of this package's original growth-path note, which
 * assumed a separate MCP server process presenting one bearer
 * credential. Everything in the chain guards EVERY request (web login
 * included), so wiring channel headers into it would let anyone who can
 * set two headers sign in as any lawyer. This resolver is a separate
 * seam the app consumes ONLY behind its channel entrance's shared-secret
 * gate; the trust model lives in the consuming app's design record
 * (first consumer: stigmer-law DD-008).
 *
 * Resolution rules, each a tested invariant:
 * - Exact match, no normalization: User.phone is validated strict E.164
 *   ("+" then digits, nothing else) and a wa_id is those digits without
 *   the "+" — so the lookup value is always `'+' + value`. There is no
 *   fuzzy layer to drift (the reference implementation needed one only
 *   because its source of truth was a hand-edited spreadsheet).
 * - Exactly one match or refuse: zero matches is "unknown"; two users
 *   sharing a phone is "ambiguous", refused rather than guessed
 *   (phone is deliberately non-unique — see migration 0002).
 * - Failure propagates: a store error must surface as an outage, never
 *   degrade to "unknown" — refusing a known lawyer during a database
 *   blip reads as confidently wrong, and confidently wrong is the one
 *   thing an identity layer may never be.
 */

import type { CallerPrincipal, ResourceStore } from "@stigmer/resource-api";
import type { User } from "./gen/stigmer/identity/user/v1/user_pb.js";
import { USER_KIND } from "./user-resource.js";

/** The sender-identity kind for a Meta-verified WhatsApp phone (wa_id). */
export const WHATSAPP_PHONE_KIND = "whatsapp_phone";

/** A channel-verified sender identity, as the agent platform asserts it. */
export interface ChannelIdentity {
  /** Identity kind token, e.g. "whatsapp_phone". Compared lowercase. */
  readonly kind: string;
  /** Identity value, e.g. the digits-only wa_id "91123456". */
  readonly value: string;
}

export type ChannelResolution =
  /** Exactly one user carries this verified identity. */
  | { readonly outcome: "resolved"; readonly principal: CallerPrincipal; readonly user: User }
  /** No user carries it (or the kind/value is not resolvable at all). */
  | { readonly outcome: "unknown" }
  /** More than one user carries it — refused, never guessed. */
  | { readonly outcome: "ambiguous" };

export type ChannelIdentityResolver = (identity: ChannelIdentity) => Promise<ChannelResolution>;

/** Digits-only, at least one digit — the shape of a wa_id. */
const WA_ID = /^[1-9][0-9]{5,14}$/;

export function createChannelIdentityResolver(store: ResourceStore): ChannelIdentityResolver {
  return async (identity) => {
    if (identity.kind.trim().toLowerCase() !== WHATSAPP_PHONE_KIND) {
      // Deny-by-default: an identity kind this resolver does not
      // understand is nobody, not a guess. New channels (Slack, email)
      // arrive as new branches with their own binding rule.
      return { outcome: "unknown" };
    }
    const value = identity.value.trim();
    if (!WA_ID.test(value)) {
      return { outcome: "unknown" };
    }

    // limit 2: one row decides "resolved", a second decides "ambiguous",
    // and totalCount confirms nothing hides beyond the page.
    const { items, totalCount } = await store.list(USER_KIND, {
      limit: 2,
      offset: 0,
      filter: { phone: `+${value}` },
    });
    if (totalCount > 1) {
      return { outcome: "ambiguous" };
    }
    const user = items[0] as User | undefined;
    const userId = user?.metadata?.id;
    if (!user || !userId) {
      return { outcome: "unknown" };
    }
    return {
      outcome: "resolved",
      principal: { id: userId, kind: "user" },
      user,
    };
  };
}
