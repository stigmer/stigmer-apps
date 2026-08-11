/**
 * The platform-token cache the browser-side SDK draws from. The backend
 * mints short-lived (~15 min) tokens strictly for the signed-in user;
 * the SDK asks for a token on every request — so this source answers
 * from memory while the cached token is comfortably fresh, re-mints
 * single-flight when it is not, and forgets everything on demand
 * (sign-out, or a platform 401 that says the token went bad early).
 *
 * Pure and framework-free so its clock-and-flight behavior is unit
 * tested without a component tree.
 */

export interface MintedToken {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
}

export interface TokenSource {
  /** A valid token — cached, or freshly minted. Throws what mint throws. */
  get(): Promise<string>;
  /** Drop the cache; the next get() mints fresh. */
  invalidate(): void;
}

/**
 * Refresh this many seconds BEFORE expiry: a token that would die
 * mid-streaming-turn is worse than an early mint, and the mint is one
 * cheap self-scoped RPC.
 */
const REFRESH_MARGIN_SECONDS = 120;

export function createTokenSource(
  mint: () => Promise<MintedToken>,
  now: () => number = Date.now,
): TokenSource {
  let cached: { token: string; freshUntilMs: number } | undefined;
  let inflight: Promise<string> | undefined;

  return {
    async get() {
      if (cached && now() < cached.freshUntilMs) {
        return cached.token;
      }
      // Single-flight: a burst of SDK requests at expiry mints once.
      inflight ??= mint()
        .then((minted) => {
          cached = {
            token: minted.accessToken,
            freshUntilMs:
              now() + Math.max(0, minted.expiresInSeconds - REFRESH_MARGIN_SECONDS) * 1000,
          };
          return minted.accessToken;
        })
        .finally(() => {
          inflight = undefined;
        });
      return inflight;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
