/**
 * The gate's refusal contract — pure unit (a fake resolver, no
 * containers): on a chat surface the copy IS the product, so which
 * sentence answers which failure is a tested invariant, including the
 * per-surface choice for an unknown caller (a WhatsApp sender is
 * taught to bind their number; a web caller's mismatch is the
 * administrator-only #377 shape — a web user has no WhatsApp number
 * to fix).
 */

import { describe, expect, it } from "vitest";
import type { CallerResolution } from "@stigmer/identity";
import { gated } from "../gate.js";
import {
  REFUSAL_AMBIGUOUS_CALLER,
  REFUSAL_NO_IDENTITY,
  REFUSAL_RECORDS_UNAVAILABLE,
  REFUSAL_UNKNOWN_CALLER,
  REFUSAL_UNKNOWN_WEB_CALLER,
} from "../refusals.js";

function resolvingTo(resolution: CallerResolution) {
  return async () => resolution;
}

async function refusalFor(
  identity: { kind: string; value: string } | undefined,
  resolution: CallerResolution,
): Promise<string> {
  const handler = gated("my_day", identity, resolvingTo(resolution), async () => ({
    content: [{ type: "text" as const, text: "should never run" }],
  }));
  const result = await handler({});
  expect(result.isError).toBe(true);
  const first = result.content[0];
  return first?.type === "text" ? first.text : "(no text)";
}

describe("the gate's refusal sentences", () => {
  it("no identity at all answers the no-identity sentence", async () => {
    expect(await refusalFor(undefined, { outcome: "unknown" })).toBe(REFUSAL_NO_IDENTITY);
  });

  it("an unknown WhatsApp sender is taught to bind their number", async () => {
    expect(
      await refusalFor({ kind: "whatsapp_phone", value: "91123456" }, { outcome: "unknown" }),
    ).toBe(REFUSAL_UNKNOWN_CALLER);
  });

  it("an unknown web caller gets the administrator sentence — not WhatsApp copy", async () => {
    expect(
      await refusalFor(
        // Re-cased on purpose: header values travel through YAML.
        { kind: " Stigmer_User ", value: "gone@firm.example" },
        { outcome: "unknown" },
      ),
    ).toBe(REFUSAL_UNKNOWN_WEB_CALLER);
  });

  it("an ambiguous caller is refused, never guessed", async () => {
    expect(
      await refusalFor({ kind: "whatsapp_phone", value: "91123999" }, { outcome: "ambiguous" }),
    ).toBe(REFUSAL_AMBIGUOUS_CALLER);
  });

  it("a resolver outage fails closed with the honest sentence — never 'unknown'", async () => {
    const handler = gated(
      "my_day",
      { kind: "stigmer_user", value: "asha@firm.example" },
      async () => {
        throw new Error("store unreachable");
      },
      async () => ({ content: [{ type: "text" as const, text: "should never run" }] }),
    );
    const result = await handler({});
    expect(result.isError).toBe(true);
    const first = result.content[0];
    expect(first?.type === "text" ? first.text : "").toBe(REFUSAL_RECORDS_UNAVAILABLE);
  });
});
