/**
 * The platform-token cache's clock-and-flight contract: answer from
 * memory while comfortably fresh, re-mint single-flight at the margin,
 * forget on demand. Pure function, fake clock — no components, no
 * network.
 */

import { describe, expect, it, vi } from "vitest";
import { createTokenSource, type MintedToken } from "../token-source.js";

function minted(token: string, expiresInSeconds = 900): MintedToken {
  return { accessToken: token, expiresInSeconds };
}

describe("createTokenSource", () => {
  it("mints once and answers from memory while fresh", async () => {
    const mint = vi.fn(async () => minted("tok-1"));
    const source = createTokenSource(mint, () => 0);

    expect(await source.get()).toBe("tok-1");
    expect(await source.get()).toBe("tok-1");
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("re-mints BEFORE expiry — a token must never die mid-turn", async () => {
    let now = 0;
    const mint = vi
      .fn<() => Promise<MintedToken>>()
      .mockResolvedValueOnce(minted("tok-1"))
      .mockResolvedValueOnce(minted("tok-2"));
    const source = createTokenSource(mint, () => now);

    expect(await source.get()).toBe("tok-1");
    // 900s lifetime, 120s margin: fresh until 780s — at 779s cached,
    // at 780s re-minted.
    now = 779_000;
    expect(await source.get()).toBe("tok-1");
    now = 780_000;
    expect(await source.get()).toBe("tok-2");
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("a burst at expiry mints exactly once (single-flight)", async () => {
    let release!: (t: MintedToken) => void;
    const mint = vi.fn(
      () => new Promise<MintedToken>((resolve) => (release = resolve)),
    );
    const source = createTokenSource(mint, () => 0);

    const burst = [source.get(), source.get(), source.get()];
    release(minted("tok-1"));
    expect(await Promise.all(burst)).toEqual(["tok-1", "tok-1", "tok-1"]);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("invalidate() forgets the cache — the next get mints fresh", async () => {
    const mint = vi
      .fn<() => Promise<MintedToken>>()
      .mockResolvedValueOnce(minted("tok-1"))
      .mockResolvedValueOnce(minted("tok-2"));
    const source = createTokenSource(mint, () => 0);

    expect(await source.get()).toBe("tok-1");
    source.invalidate();
    expect(await source.get()).toBe("tok-2");
  });

  it("a failed mint caches nothing — the next get tries again", async () => {
    const mint = vi
      .fn<() => Promise<MintedToken>>()
      .mockRejectedValueOnce(new Error("platform down"))
      .mockResolvedValueOnce(minted("tok-after-outage"));
    const source = createTokenSource(mint, () => 0);

    await expect(source.get()).rejects.toThrowError("platform down");
    expect(await source.get()).toBe("tok-after-outage");
  });
});
