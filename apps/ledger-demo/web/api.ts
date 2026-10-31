/**
 * The page's calls to Acme's own server. Stigmer is called only through the SDK, with tokens from
 * `/api/token`; nothing here holds a Stigmer key.
 */
import type { BooksView } from "../server/books.js";

export type { AccountView, Adjustment, BooksView } from "../server/books.js";

export interface PersonEntry {
  readonly id: string;
  readonly name: string;
  readonly customer: { readonly slug: string; readonly name: string };
}

export interface AppConfig {
  readonly stigmerUrl: string;
  readonly agent: { readonly org: string; readonly slug: string };
  readonly people: readonly PersonEntry[];
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Who is signed in to Acme, or nobody. */
export type Me = { readonly signedIn: false } | { readonly signedIn: true; readonly person: { readonly id: string } };

export const api = {
  config: () => call<AppConfig>("/api/config"),
  me: () => call<Me>("/api/me"),
  /** Signs in with Acme's passcode; the answer's status says why when it is refused. */
  signIn: async (personId: string, passcode: string): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const res = await fetch("/api/sign-in", { credentials: "same-origin", ...post({ personId, passcode }) });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, reason: body.error ?? `Sign-in failed (${res.status}).` };
  },
  switchTo: (personId: string) => call<unknown>("/api/switch", post({ personId })),
  signOut: () => call<unknown>("/api/sign-out", post({})),
  token: () => call<{ accessToken: string; expiresAt: string }>("/api/token"),
  ledger: () => call<BooksView>("/api/ledger"),
  rememberConversation: (sessionId: string) => call<unknown>("/api/conversations", post({ sessionId })),
  conversations: () => call<Record<string, string>>("/api/presenter/conversations"),
  reset: () => call<unknown>("/api/presenter/reset", post({})),
};

const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });

/** An amount as the books print it. */
export function formatMoney(amount: number): string {
  return money.format(amount);
}

/** A variance with its sign, "on budget" at zero. */
export function formatVariance(variance: number): string {
  if (variance === 0) return "on budget";
  return `${variance > 0 ? "+" : "−"}${money.format(Math.abs(variance))}`;
}
