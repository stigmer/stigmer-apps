/**
 * Acme's sign-in pieces on their own: a cookie verifies only under the key that signed it, and the
 * passcode stops answering after too many wrong tries in a minute, then answers again.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_WRONG_PER_MINUTE, Sessions } from "./session.js";

describe("Sessions", () => {
  it("verifies its own cookie and refuses one signed by another key or tampered with", () => {
    const sessions = new Sessions("a long passcode", Date.now, randomBytes(32));
    const value = sessions.issue("usr-dana");
    expect(sessions.verify(value)).toBe("usr-dana");
    expect(new Sessions("a long passcode", Date.now, randomBytes(32)).verify(value)).toBeUndefined();
    expect(sessions.verify(value.replace("usr-dana", "usr-priya"))).toBeUndefined();
    expect(sessions.verify("usr-dana")).toBeUndefined();
    expect(sessions.verify(undefined)).toBeUndefined();
  });

  it("limits wrong passcodes per minute, and lets the right one in again after the minute", () => {
    let now = 1_000_000;
    const sessions = new Sessions("a long passcode", () => now);
    for (let i = 0; i < MAX_WRONG_PER_MINUTE; i++) expect(sessions.checkPasscode("guess")).toBe("wrong");
    expect(sessions.checkPasscode("a long passcode")).toBe("limited");
    now += 61_000;
    expect(sessions.checkPasscode("a long passcode")).toBe("ok");
  });
});
