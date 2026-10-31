/**
 * Acme's `/api` over real HTTP, with Stigmer's mint replaced by a recorder. On a public address the
 * server must decide who is signed in: only the passcode signs in, a cookie that was not signed by
 * the server is nobody, and every route but the names answers only a signed-in person, with that
 * person's own customer's data and tokens.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CUSTOMERS, type Customer, type Person } from "../fixtures/books.js";
import { apiHandler } from "./api.js";
import { Books } from "./books.js";
import { SESSION_COOKIE, Sessions } from "./session.js";

const PASSCODE = "correct horse battery";

let server: Server;
let base: string;
let minted: { org: string; userId: string }[];
let books: Books;

beforeEach(async () => {
  minted = [];
  books = new Books(CUSTOMERS);
  const api = apiHandler({
    books,
    stigmerUrl: "https://stigmer.test",
    sessions: new Sessions(PASSCODE),
    secureCookies: true,
    mint: async (customer: Customer, person: Person) => {
      minted.push({ org: customer.slug, userId: person.id });
      return { accessToken: `token-for-${person.id}`, expiresAt: new Date("2026-11-09T10:00:00Z") };
    },
  });
  server = createServer((req, res) => {
    void api(req, res).then((served) => {
      if (!served) res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const post = (body: unknown, cookie?: string): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: cookie ? { cookie } : {},
});

async function signIn(personId: string): Promise<string> {
  const res = await fetch(`${base}/api/sign-in`, post({ personId, passcode: PASSCODE }));
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  expect(setCookie).toMatch(/HttpOnly/);
  expect(setCookie).toMatch(/SameSite=Strict/);
  expect(setCookie).toMatch(/Secure/);
  return setCookie.split(";")[0]!;
}

describe("Acme's sign-in", () => {
  it("refuses a wrong passcode and sets no cookie", async () => {
    const res = await fetch(`${base}/api/sign-in`, post({ personId: "usr-dana", passcode: "guess" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("treats a cookie the server did not sign as nobody", async () => {
    for (const forged of [`${SESSION_COOKIE}=usr-dana`, `${SESSION_COOKIE}=usr-dana.AAAA`, `${SESSION_COOKIE}=usr-priya.${"x".repeat(43)}`]) {
      expect((await fetch(`${base}/api/token`, { headers: { cookie: forged } })).status).toBe(401);
      expect(await (await fetch(`${base}/api/me`, { headers: { cookie: forged } })).json()).toEqual({ signedIn: false });
    }
    expect(minted).toEqual([]);
  });

  it("answers every route but the names with 401 to nobody", async () => {
    expect((await fetch(`${base}/api/config`)).status).toBe(200);
    for (const [method, path] of [
      ["GET", "/api/token"],
      ["GET", "/api/ledger"],
      ["POST", "/api/switch"],
      ["POST", "/api/conversations"],
      ["GET", "/api/presenter/conversations"],
      ["POST", "/api/presenter/reset"],
    ] as const) {
      expect((await fetch(`${base}${path}`, { method })).status, `${method} ${path}`).toBe(401);
    }
  });

  it("switches people only inside a signed-in session", async () => {
    const dana = await signIn("usr-dana");
    const res = await fetch(`${base}/api/switch`, post({ personId: "usr-priya" }, dana));
    expect(res.status).toBe(200);
    const priya = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(await (await fetch(`${base}/api/me`, { headers: { cookie: priya } })).json()).toMatchObject({ signedIn: true, person: { id: "usr-priya" } });
  });

  it("signs out by clearing the cookie", async () => {
    const dana = await signIn("usr-dana");
    const res = await fetch(`${base}/api/sign-out`, post({}, dana));
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });
});

describe("Acme's /api for a signed-in person", () => {
  it("mints the signed-in person's token into their own customer's organization", async () => {
    const priya = await signIn("usr-priya");
    const res = await fetch(`${base}/api/token`, { headers: { cookie: priya } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accessToken: "token-for-usr-priya", expiresAt: "2026-11-09T10:00:00.000Z" });
    expect(minted).toEqual([{ org: "blue-fern-press", userId: "usr-priya" }]);
  });

  it("serves only the signed-in person's customer's books", async () => {
    books.post(CUSTOMERS[0]!, { from: "Marketing", to: "Software", amount: 4800, reason: "miscoded", by: "Dana, through the agent" });
    const priya = await signIn("usr-priya");
    const view = (await (await fetch(`${base}/api/ledger`, { headers: { cookie: priya } })).json()) as { customer: { slug: string }; adjustments: unknown[] };
    expect(view.customer.slug).toBe("blue-fern-press");
    expect(view.adjustments).toEqual([]);
    const dana = await signIn("usr-dana");
    const hers = (await (await fetch(`${base}/api/ledger`, { headers: { cookie: dana } })).json()) as { adjustments: unknown[] };
    expect(hers.adjustments).toHaveLength(1);
  });

  it("names the Agent by Acme's organization and lists every person with their customer", async () => {
    const config = (await (await fetch(`${base}/api/config`)).json()) as { agent: unknown; people: { id: string; customer: { slug: string } }[] };
    expect(config.agent).toEqual({ org: "acme-books", slug: "variance-reporter" });
    expect(config.people.map((p) => [p.id, p.customer.slug])).toEqual([
      ["usr-dana", "northwind-books"],
      ["usr-priya", "blue-fern-press"],
    ]);
  });

  it("remembers each person's latest conversation for the presenter, and forgets it on reset", async () => {
    const dana = await signIn("usr-dana");
    await fetch(`${base}/api/conversations`, post({ sessionId: "ses_1" }, dana));
    expect(await (await fetch(`${base}/api/presenter/conversations`, { headers: { cookie: dana } })).json()).toEqual({ "usr-dana": "ses_1" });
    await fetch(`${base}/api/presenter/reset`, post({}, dana));
    expect(await (await fetch(`${base}/api/presenter/conversations`, { headers: { cookie: dana } })).json()).toEqual({});
  });
});
