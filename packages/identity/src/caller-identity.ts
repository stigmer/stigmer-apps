/**
 * Caller identity resolution (T05): a platform-asserted caller identity
 * resolved to a user-kind CallerPrincipal by exact match against the
 * User store. Two identity kinds exist, each with its own binding rule:
 *
 * - `whatsapp_phone` — a messaging-channel-verified sender (a WhatsApp
 *   wa_id, verified by Meta and asserted by the agent platform),
 *   matched by exact E.164 phone.
 * - `stigmer_user` — a platform-authenticated user (a lawyer signed
 *   into the embedding app, whose backend minted them a platform token;
 *   the platform asserts the email it provisioned at mint time),
 *   matched by exact email — the User resource's natural key.
 *
 * The module was renamed from channel-identity when the second kind
 * arrived: `stigmer_user` is not a channel (in platform vocabulary a
 * channel is Slack/WhatsApp), and the platform's own name for this
 * mechanism — and for the wire headers carrying it,
 * `X-Stigmer-Caller-Kind`/`-Value` — is CALLER identity.
 *
 * Deliberately NOT an `Authenticator` in the app's chain — this is a
 * recorded correction of this package's original growth-path note, which
 * assumed a separate MCP server process presenting one bearer
 * credential. Everything in the chain guards EVERY request (web login
 * included), so wiring caller headers into it would let anyone who can
 * set two headers sign in as any lawyer. This resolver is a separate
 * seam the app consumes ONLY behind its MCP entrance's shared-secret
 * gate; the trust model lives in the consuming app's design record
 * (first consumer: stigmer-law DD-008).
 *
 * Resolution rules, each a tested invariant:
 * - Exact match, no normalization: User.phone is validated strict E.164
 *   ("+" then digits, nothing else) and a wa_id is those digits without
 *   the "+" — so the lookup value is always `'+' + value`. User.email is
 *   stored lowercase (the resource pipeline normalizes on both write
 *   paths), so the lookup value is the asserted email lowercased. There
 *   is no fuzzy layer to drift (the reference implementation needed one
 *   only because its source of truth was a hand-edited spreadsheet).
 * - Exactly one match or refuse: zero matches is "unknown"; two users
 *   sharing a phone is "ambiguous", refused rather than guessed
 *   (phone is deliberately non-unique — see migration 0002). Email
 *   cannot be ambiguous by construction: it is the natural key, unique
 *   at the database, so its branch resolves through getByNaturalKey and
 *   has no ambiguous arm.
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

/** The caller-identity kind for a platform-authenticated user (email). */
export const STIGMER_USER_KIND = "stigmer_user";

/** A platform-asserted caller identity, as the agent platform delivers it. */
export interface CallerIdentity {
  /** Identity kind token, e.g. "whatsapp_phone". Compared lowercase. */
  readonly kind: string;
  /** Identity value, e.g. the digits-only wa_id "91123456", or an email. */
  readonly value: string;
}

export type CallerResolution =
  /** Exactly one user carries this verified identity. */
  | { readonly outcome: "resolved"; readonly principal: CallerPrincipal; readonly user: User }
  /** No user carries it (or the kind/value is not resolvable at all). */
  | { readonly outcome: "unknown" }
  /** More than one user carries it — refused, never guessed. */
  | { readonly outcome: "ambiguous" };

export type CallerIdentityResolver = (identity: CallerIdentity) => Promise<CallerResolution>;

/** Digits-only, at least one digit — the shape of a wa_id. */
const WA_ID = /^[1-9][0-9]{5,14}$/;

export function createCallerIdentityResolver(store: ResourceStore): CallerIdentityResolver {
  return async (identity) => {
    switch (identity.kind.trim().toLowerCase()) {
      case WHATSAPP_PHONE_KIND:
        return resolveByPhone(store, identity.value);
      case STIGMER_USER_KIND:
        return resolveByEmail(store, identity.value);
      default:
        // Deny-by-default: an identity kind this resolver does not
        // understand is nobody, not a guess. New kinds (Slack, email)
        // arrive as new branches with their own binding rule.
        return { outcome: "unknown" };
    }
  };
}

async function resolveByPhone(store: ResourceStore, rawValue: string): Promise<CallerResolution> {
  const value = rawValue.trim();
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
  return resolved(items[0] as User | undefined);
}

async function resolveByEmail(store: ResourceStore, rawValue: string): Promise<CallerResolution> {
  const value = rawValue.trim().toLowerCase();
  // The platform prefers email but falls back to an opaque account id
  // when it holds no email for the caller — an id can never bind to a
  // User here, so anything not email-shaped is nobody without a lookup.
  if (value === "" || !value.includes("@")) {
    return { outcome: "unknown" };
  }
  // Email is the User natural key (unique at the database), so this
  // lookup is exactly-one-or-nobody by construction — no ambiguous arm.
  const user = await store.getByNaturalKey(USER_KIND, value);
  return resolved(user as User | undefined);
}

function resolved(user: User | undefined): CallerResolution {
  const userId = user?.metadata?.id;
  if (!user || !userId) {
    return { outcome: "unknown" };
  }
  return {
    outcome: "resolved",
    principal: { id: userId, kind: "user" },
    user,
  };
}
