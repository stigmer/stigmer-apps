/**
 * Resource id generation: `{prefix}_{ulid}` in lowercase, the same scheme
 * as the Go edition (`agt_01arz3ndektsv4rrffq69g5fav`). ULIDs are
 * time-ordered, which keeps primary-key locality in ordered stores and
 * makes ids sort by creation time for free.
 */

import { ulid } from "ulidx";

export function generateResourceId(prefix: string): string {
  if (!/^[a-z][a-z0-9]*$/.test(prefix)) {
    // Misconfiguration, not user input — fail loudly at first use.
    throw new Error(
      `Resource id prefix must be lowercase alphanumeric starting with a letter, got '${prefix}'`,
    );
  }
  return `${prefix}_${ulid().toLowerCase()}`;
}
