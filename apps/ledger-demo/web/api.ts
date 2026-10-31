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

export const api = {
  config: () => call<AppConfig>("/api/config"),
  me: async (): Promise<string | undefined> => {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    if (res.status === 401) return undefined;
    if (!res.ok) throw new Error(`/api/me: ${res.status}`);
    return ((await res.json()) as { person: { id: string } }).person.id;
  },
  signIn: (personId: string) => call<unknown>("/api/sign-in", post({ personId })),
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
