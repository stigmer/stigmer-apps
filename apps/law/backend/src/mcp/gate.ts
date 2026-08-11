/**
 * The one enforcement point every tool handler passes through. Its ONLY
 * job is "who is calling": resolve the caller identity to a real user
 * or refuse with the exact relayable sentence. It deliberately carries
 * NO tool-to-permission table — the reference implementation keeps one,
 * and copying it here would create a second definition of "what may
 * this person do" beside the app's policy module (DD-A5 forbids exactly
 * that). Once a caller is resolved, the tool body runs the same
 * pipelines the web app uses, and the policy module answers everything;
 * when per-case access control lands, this surface inherits it the same
 * day with no table to remember to update.
 *
 * Identity is resolved FRESH on every call — no cache. A cached
 * resolution means a lawyer whose number was just removed keeps acting
 * for the cache's lifetime (the reference project designed a 60s cache
 * in and then deleted it for this reason).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Code, ConnectError } from "@connectrpc/connect";
import type { CallerPrincipal } from "@stigmer/resource-api";
import {
  STIGMER_USER_KIND,
  type CallerIdentity,
  type CallerIdentityResolver,
  type User,
} from "@stigmer/identity";
import { identityLogToken } from "./identity.js";
import {
  REFUSAL_AMBIGUOUS_CALLER,
  REFUSAL_NO_IDENTITY,
  REFUSAL_RECORDS_UNAVAILABLE,
  REFUSAL_UNKNOWN_CALLER,
  REFUSAL_UNKNOWN_WEB_CALLER,
} from "./refusals.js";

/** A resolved staff caller: the principal for pipelines, the user for copy. */
export interface StaffCaller {
  readonly principal: CallerPrincipal;
  readonly user: User;
}

export function textResult(text: string, structuredContent?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Client-shaped pipeline answers are relayed VERBATIM — the pipeline's
 * error messages name the resource and value by design (errors are UX),
 * and the policy module's denial sentences are the authorization
 * surface. Server-shaped failures collapse to the honest unavailable
 * sentence and a log line; a stack trace is not a chat message.
 */
const RELAYED_CODES = new Set<Code>([
  Code.InvalidArgument,
  Code.NotFound,
  Code.AlreadyExists,
  Code.FailedPrecondition,
  Code.PermissionDenied,
  Code.Unauthenticated,
]);

export function gated<Args>(
  tool: string,
  identity: CallerIdentity | undefined,
  resolveCallerIdentity: CallerIdentityResolver,
  handler: (args: Args, caller: StaffCaller) => Promise<CallToolResult>,
): (args: Args) => Promise<CallToolResult> {
  return async (args) => {
    const startedAt = Date.now();
    const logCall = (outcome: string) =>
      console.info(
        JSON.stringify({
          msg: "mcp tool call",
          tool,
          caller: identityLogToken(identity),
          outcome,
          duration_ms: Date.now() - startedAt,
        }),
      );

    if (!identity) {
      logCall("refused:no-identity");
      return errorResult(REFUSAL_NO_IDENTITY);
    }

    let caller: StaffCaller;
    try {
      const resolution = await resolveCallerIdentity(identity);
      if (resolution.outcome === "unknown") {
        logCall("refused:unknown");
        // The refusal teaches the caller's OWN way in, so it is worded
        // per surface: a web caller has no WhatsApp number to fix.
        return errorResult(
          identity.kind.trim().toLowerCase() === STIGMER_USER_KIND
            ? REFUSAL_UNKNOWN_WEB_CALLER
            : REFUSAL_UNKNOWN_CALLER,
        );
      }
      if (resolution.outcome === "ambiguous") {
        logCall("refused:ambiguous");
        return errorResult(REFUSAL_AMBIGUOUS_CALLER);
      }
      caller = { principal: resolution.principal, user: resolution.user };
    } catch (err) {
      // Resolution failing must never fall through to "unknown" — that
      // would refuse a known lawyer during an outage, confidently and
      // wrongly. Fail closed with the honest sentence.
      console.error(`mcp identity resolution failed (tool=${tool}):`, err);
      logCall("error:identity-resolution");
      return errorResult(REFUSAL_RECORDS_UNAVAILABLE);
    }

    try {
      const result = await handler(args, caller);
      logCall(result.isError ? "refused" : "ok");
      return result;
    } catch (err) {
      const cerr = ConnectError.from(err);
      if (RELAYED_CODES.has(cerr.code)) {
        logCall(`refused:${Code[cerr.code]}`);
        return errorResult(cerr.rawMessage);
      }
      console.error(`mcp tool failed (tool=${tool}):`, err);
      logCall("error");
      return errorResult(REFUSAL_RECORDS_UNAVAILABLE);
    }
  };
}
