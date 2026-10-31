/**
 * Acme's own sign-in, the part of the demo that stands in for an integrator's real one: a passcode
 * lets the presenter in, and a signed cookie then says which of Acme's people is signed in.
 *
 * - The cookie is `<person id>.<HMAC-SHA256 of it>`, signed with a key made when the server starts.
 *   It can't be forged without the key, and a restart signs everyone out, which a demo can afford.
 * - The passcode is compared in constant time, and wrong guesses are limited per minute, because the
 *   page is on a public address.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "acme_session";

/** Wrong passcodes accepted per minute before the sign-in answers "too many tries". */
export const MAX_WRONG_PER_MINUTE = 10;

export class Sessions {
  private readonly key: Buffer;
  private wrong: number[] = [];

  constructor(
    private readonly passcode: string,
    private readonly now: () => number = Date.now,
    key: Buffer = randomBytes(32),
  ) {
    this.key = key;
  }

  /** Whether `attempt` is the passcode: "ok", "wrong", or "limited" after too many wrong tries. */
  checkPasscode(attempt: string): "ok" | "wrong" | "limited" {
    const minuteAgo = this.now() - 60_000;
    this.wrong = this.wrong.filter((t) => t > minuteAgo);
    if (this.wrong.length >= MAX_WRONG_PER_MINUTE) return "limited";
    const digest = (s: string) => createHash("sha256").update(s).digest();
    if (timingSafeEqual(digest(attempt), digest(this.passcode))) return "ok";
    this.wrong.push(this.now());
    return "wrong";
  }

  private mac(personId: string): string {
    return createHmac("sha256", this.key).update(personId).digest("base64url");
  }

  /** The cookie value for a signed-in person. */
  issue(personId: string): string {
    return `${personId}.${this.mac(personId)}`;
  }

  /** The person a cookie value names, when its signature holds. */
  verify(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const dot = value.lastIndexOf(".");
    if (dot <= 0) return undefined;
    const personId = value.slice(0, dot);
    const given = Buffer.from(value.slice(dot + 1));
    const expected = Buffer.from(this.mac(personId));
    return given.length === expected.length && timingSafeEqual(given, expected) ? personId : undefined;
  }
}
