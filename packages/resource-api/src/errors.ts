/**
 * The uniform error contract. Errors are UX: every message names the
 * resource and the offending value so clients can surface it verbatim
 * ("mongo: no documents in result" is not an error message; "Case
 * 'CRL-142/2025' not found" is).
 *
 * ConnectError is the one error type that crosses the wire with its code
 * intact. The Go edition learned this the hard way: a bare error surfaced
 * as UNKNOWN across every create path in production. Rule: anything a
 * client can trigger gets a typed ConnectError here; bare errors are
 * reserved for should-never-happen invariants (the pipeline maps those to
 * INTERNAL, never UNKNOWN).
 */

import { Code, ConnectError } from "@connectrpc/connect";

export function invalidArgument(message: string): ConnectError {
  return new ConnectError(message, Code.InvalidArgument);
}

export function notFound(resource: string, ref: string): ConnectError {
  return new ConnectError(`${resource} '${ref}' not found`, Code.NotFound);
}

export function alreadyExists(
  resource: string,
  keyLabel: string,
  value: string,
): ConnectError {
  return new ConnectError(
    `${resource} with ${keyLabel} '${value}' already exists`,
    Code.AlreadyExists,
  );
}

/**
 * The request was well-formed but system state does not support it — the
 * canonical answer for a missing *referenced* resource (the Go edition's
 * ValidateReferencesStep precedent; NOT_FOUND is reserved for the target
 * of the operation itself).
 */
export function failedPrecondition(message: string): ConnectError {
  return new ConnectError(message, Code.FailedPrecondition);
}

export function unauthenticated(message = "Authentication required"): ConnectError {
  return new ConnectError(message, Code.Unauthenticated);
}

export function permissionDenied(message: string): ConnectError {
  return new ConnectError(message, Code.PermissionDenied);
}

export function internal(message: string, cause?: unknown): ConnectError {
  return new ConnectError(message, Code.Internal, undefined, undefined, cause);
}
