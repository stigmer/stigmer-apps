/**
 * Acme's `/api` over real HTTP, with Stigmer's mint replaced by a recorder: the server decides who
 * is signed in, mints into that person's own customer's organization, and serves only that
 * customer's books.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CUSTOMERS, type Customer, type Person } from "../fixtures/books.js";
import { apiHandler, PERSON_COOKIE } from "./api.js";
import { Books } from "./books.js";

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

async function signIn(personId: string): Promise<string> {
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", body: JSON.stringify({ personId }) });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie") ?? "";
  expect(cookie).toContain("HttpOnly");
  return cookie.split(";")[0]!;
}

describe("Acme's /api", () => {
  it("mints the signed-in person's token into their own customer's organization", async () => {
    const priya = await signIn("usr-priya");
    const res = await fetch(`${base}/api/token`, { headers: { cookie: priya } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accessToken: "token-for-usr-priya", expiresAt: "2026-11-09T10:00:00.000Z" });
    expect(minted).toEqual([{ org: "blue-fern-press", userId: "usr-priya" }]);
  });

  it("mints nothing for nobody, and nothing for a person it does not know", async () => {
    expect((await fetch(`${base}/api/token`)).status).toBe(401);
    expect((await fetch(`${base}/api/token`, { headers: { cookie: `${PERSON_COOKIE}=usr-mallory` } })).status).toBe(401);
    expect((await fetch(`${base}/api/sign-in`, { method: "POST", body: JSON.stringify({ personId: "usr-mallory" }) })).status).toBe(404);
    expect(minted).toEqual([]);
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
    await fetch(`${base}/api/conversations`, { method: "POST", headers: { cookie: dana }, body: JSON.stringify({ sessionId: "ses_1" }) });
    expect(await (await fetch(`${base}/api/presenter/conversations`)).json()).toEqual({ "usr-dana": "ses_1" });
    await fetch(`${base}/api/presenter/reset`, { method: "POST" });
    expect(await (await fetch(`${base}/api/presenter/conversations`)).json()).toEqual({});
  });
});
