/**
 * protovalidate integration: rules live in the proto files
 * (`buf.validate` annotations), never in handler code — the same
 * arrangement as both parents. One process-wide validator so rules compile
 * once (the Go edition's SharedValidator).
 *
 * This in-pipeline check is deliberately redundant with any transport-level
 * validate interceptor: direct in-process calls and tests bypass
 * interceptors, and validation must hold there too (the Go edition
 * documents the same double arrangement).
 */

import type { DescMessage } from "@bufbuild/protobuf";
import { createValidator, type Validator } from "@bufbuild/protovalidate";
import { internal, invalidArgument } from "./errors.js";

let shared: Validator | undefined;

export function sharedValidator(): Validator {
  shared ??= createValidator();
  return shared;
}

/** Throws INVALID_ARGUMENT listing every violation (errors are UX). */
export function validateMessage(
  schema: DescMessage,
  message: unknown,
  subject: string,
): void {
  const result = sharedValidator().validate(schema, message as never);
  if (result.kind === "valid") {
    return;
  }
  if (result.kind === "invalid") {
    const details = result.violations
      .map((v) => v.toString())
      .join("; ");
    throw invalidArgument(`Invalid ${subject}: ${details}`);
  }
  // "error": the rules themselves failed to evaluate — a programming
  // error in the proto annotations, not a client mistake.
  throw internal(`Validation rules failed to evaluate for ${subject}`, result.error);
}
