/**
 * Caller-identity headers → CallerIdentity, plus the privacy-safe log
 * token. The agent platform templates its runner-verified caller
 * identity into two headers on every MCP request (the documented
 * caller-identity contract); tool DISCOVERY runs with no session and
 * presents the anonymous sentinel — which must list tools normally and
 * only refuse tool CALLS (a tool hidden from discovery is never
 * classified, and an unclassified tool runs ungated).
 */

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { CallerIdentity } from "@stigmer/identity";

export const CALLER_KIND_HEADER = "x-stigmer-caller-kind";
export const CALLER_VALUE_HEADER = "x-stigmer-caller-value";

/** The platform's explicit "no caller" sentinel (discovery, console). */
const ANONYMOUS_KIND = "anonymous";

function headerValue(req: IncomingMessage, name: string): string {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value ?? "").trim();
}

/**
 * Parses the caller-identity headers. A half identity is not something
 * to guess about: missing kind, the anonymous sentinel, or an empty
 * value all mean "no identity" — the gate then refuses tool calls with
 * the no-identity sentence while discovery proceeds normally.
 */
export function callerIdentityFromHeaders(req: IncomingMessage): CallerIdentity | undefined {
  const kind = headerValue(req, CALLER_KIND_HEADER).toLowerCase();
  const value = headerValue(req, CALLER_VALUE_HEADER);
  if (kind === "" || kind === ANONYMOUS_KIND || value === "") {
    return undefined;
  }
  return { kind, value };
}

/**
 * A short, stable correlation token for logs. The raw identity value is
 * a phone number or an email — personal data that never enters a log
 * line (and the repo's CI guard would fail on a real-shaped number
 * anyway); the hash prefix lets an operator correlate one caller's
 * requests without learning who they are.
 */
export function identityLogToken(identity: CallerIdentity | undefined): string {
  if (!identity) return "anonymous";
  return createHash("sha256")
    .update(`${identity.kind}:${identity.value}`)
    .digest("hex")
    .slice(0, 8);
}
