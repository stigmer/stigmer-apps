/**
 * Every sentence the MCP surface can refuse with, in one place — on a
 * chat surface the copy IS the product, and the agent relays these
 * verbatim. Rules (the reference implementation's, kept): name the
 * boundary and the way in, never the mechanism ("ask your firm
 * administrator", not "role resolution returned guest"); an unknown
 * caller's refusal TEACHES, because that caller is usually a real
 * lawyer whose number just isn't on their profile yet.
 *
 * Deliberately NOT here: refusals for what a signed-in lawyer may not
 * do. Those sentences come from the app's one policy module through the
 * pipeline (relayed verbatim by the gate) — a second copy here would be
 * a second definition of "what may this person do".
 */

/** No caller identity at all (console test call, misconfigured channel). */
export const REFUSAL_NO_IDENTITY =
  "I can only act for a verified WhatsApp sender, and this conversation " +
  "did not carry one. If you are testing from the console, this is " +
  "expected — the tools work only on the WhatsApp channel.";

/** A verified number that matches no user — teach the way in. */
export const REFUSAL_UNKNOWN_CALLER =
  "I don't recognize this WhatsApp number yet. Ask your firm " +
  "administrator to add it to your profile in the case system, then " +
  "message me again.";

/** A verified number matching MORE than one user — refuse, never guess. */
export const REFUSAL_AMBIGUOUS_CALLER =
  "This WhatsApp number is linked to more than one account, so I can't " +
  "tell who is asking. Ask your firm administrator to keep the number " +
  "on just your profile.";

/** The records are unreachable — fail closed, honestly. */
export const REFUSAL_RECORDS_UNAVAILABLE =
  "I can't reach the firm's records right now. Please try again in a " +
  "few minutes.";
