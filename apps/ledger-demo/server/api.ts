/**
 * Acme Books' own `/api`, the part of any integrator's backend the page talks to.
 *
 * - Sign-in is a stand-in: the account switcher posts a person's id and the server keeps it in a
 *   cookie. A real product has its own sign-in; what matters is that the server, not the page,
 *   decides who is signed in, and every route below reads only that.
 * - `/api/token` is the tutorial's route: it mints a short-lived Stigmer token for the signed-in
 *   person, into their customer's organization, with the key of the minting service account that
 *   lives in that organization. The customer's embedding settings name its vault only for people
 *   minted that way, so the key of the customer's ledger reaches their conversations and no one
 *   else's.
 * - `/api/ledger` is Acme's own data, for the signed-in person's customer only.
 * - `/api/presenter/*` serves the presenter's drawer and the rehearsal reset.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { ACME, CUSTOMERS, personById, type Customer, type Person } from "../fixtures/books.js";
import type { Books } from "./books.js";

export const PERSON_COOKIE = "acme_person";

/** A minted Stigmer user token. */
export interface MintedToken {
  readonly accessToken: string;
  readonly expiresAt: Date;
}

export interface ApiDeps {
  readonly books: Books;
  readonly stigmerUrl: string;
  /** Mints the person's token into the customer's organization. */
  readonly mint: (customer: Customer, person: Person) => Promise<MintedToken>;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function signedIn(req: IncomingMessage): { customer: Customer; person: Person } | undefined {
  const id = cookie(req, PERSON_COOKIE);
  return id ? personById(id) : undefined;
}

/** The handler for every `/api` route; answers false for a path it does not serve. */
export function apiHandler(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  /** The latest conversation each person opened, by Acme's user id, for the presenter's drawer. */
  const conversations = new Map<string, string>();

  return async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const route = `${req.method} ${path}`;

    if (route === "GET /api/config") {
      json(res, 200, {
        stigmerUrl: deps.stigmerUrl,
        agent: { org: ACME.org, slug: ACME.agent },
        people: CUSTOMERS.flatMap((c) => c.people.map((p) => ({ id: p.id, name: p.name, customer: { slug: c.slug, name: c.name } }))),
      });
      return true;
    }

    if (route === "POST /api/sign-in") {
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
      const found = typeof body.personId === "string" ? personById(body.personId) : undefined;
      if (!found) {
        json(res, 404, { error: "No such person." });
        return true;
      }
      json(res, 200, { person: found.person, customer: { slug: found.customer.slug, name: found.customer.name } }, {
        "set-cookie": `${PERSON_COOKIE}=${encodeURIComponent(found.person.id)}; Path=/; HttpOnly; SameSite=Strict`,
      });
      return true;
    }

    if (!path.startsWith("/api/")) return false;
    const who = signedIn(req);

    if (route === "GET /api/me") {
      if (!who) json(res, 401, { error: "Nobody is signed in." });
      else json(res, 200, { person: who.person, customer: { slug: who.customer.slug, name: who.customer.name } });
      return true;
    }

    if (route === "GET /api/token") {
      if (!who) {
        json(res, 401, { error: "Nobody is signed in." });
        return true;
      }
      try {
        const { accessToken, expiresAt } = await deps.mint(who.customer, who.person);
        json(res, 200, { accessToken, expiresAt: expiresAt.toISOString() });
      } catch (error) {
        json(res, 502, { error: `Stigmer refused the token: ${error instanceof Error ? error.message : String(error)}` });
      }
      return true;
    }

    if (route === "GET /api/ledger") {
      if (!who) json(res, 401, { error: "Nobody is signed in." });
      else json(res, 200, deps.books.view(who.customer));
      return true;
    }

    if (route === "POST /api/conversations") {
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
      if (!who || typeof body.sessionId !== "string" || body.sessionId === "") {
        json(res, 400, { error: "Sign in and name the conversation." });
        return true;
      }
      conversations.set(who.person.id, body.sessionId);
      json(res, 200, {});
      return true;
    }

    if (route === "GET /api/presenter/conversations") {
      json(res, 200, Object.fromEntries(conversations));
      return true;
    }

    if (route === "POST /api/presenter/reset") {
      deps.books.reset();
      conversations.clear();
      json(res, 200, {});
      return true;
    }

    json(res, 404, { error: "No such route." });
    return true;
  };
}
