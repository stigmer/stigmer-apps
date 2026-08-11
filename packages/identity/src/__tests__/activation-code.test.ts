import { describe, expect, it } from "vitest";
import {
  ACTIVATION_CODE_PREFIX,
  generateActivationCode,
  hashActivationCode,
} from "../activation-code.js";

describe("activation codes", () => {
  it("generates prefixed, unique codes with matching hashes", () => {
    const first = generateActivationCode();
    const second = generateActivationCode();

    expect(first.code.startsWith(ACTIVATION_CODE_PREFIX)).toBe(true);
    // 16 random bytes → 22 base64url chars: the entropy floor the
    // module doc claims (128 bits) is structural, not aspirational.
    expect(first.code.length).toBeGreaterThanOrEqual(ACTIVATION_CODE_PREFIX.length + 22);
    expect(first.code).not.toBe(second.code);
    expect(first.sha256Hex).toBe(hashActivationCode(first.code));
    expect(first.sha256Hex).not.toBe(second.sha256Hex);
  });

  it("hashes deterministically and case-sensitively", () => {
    const { code, sha256Hex } = generateActivationCode();
    expect(hashActivationCode(code)).toBe(sha256Hex);
    expect(hashActivationCode(code.toUpperCase())).not.toBe(sha256Hex);
  });
});
