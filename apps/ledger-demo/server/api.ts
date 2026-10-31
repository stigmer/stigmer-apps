/**
 * Acme Books' own `/api`, the part of any integrator's backend the page talks to.
 *
 * - Sign-in stands in for Acme's real one (`session.ts`): the passcode lets the presenter in as one
 *   of Acme's people, and the switcher moves between them. What matters is that the server, not the
 *   page, decides who is signed in, and every route below reads only that.
 * - `/api/token` is the tutorial's route: it mints a short-lived Stigmer token for the signed-in
 *   person, into their customer's organization, with the key of the minting service account that
 *   lives in that organization. The customer's embedding settings name its vault only for people
 *   minted that way, so the key of the customer's ledger reaches their conversations and no one
 *   else's.
 * - `/api/ledger` is Acme's own data, for the signed-in person's customer only.
 * - `/api/presenter/*` serves the presenter's drawer and the rehearsal reset.
 *
 * Only `/api/config` (names, no data) answers without a session.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { ACME, CUSTOMERS, personById, type Customer, type Person } from "../fixtures/books.js";
import type { Books } from "./books.js";
import { SESSION_COOKIE, type Sessions } from "./session.js";

/** A minted Stigmer user token. */
export interface MintedToken {
  readonly accessToken: string;
  readonly expiresAt: Date;
}

export interface ApiDeps {
  readonly books: Books;
  readonly stigmerUrl: string;
  readonly sessions: Sessions;
  /** Whether the session cookie is marked Secure: true wherever the page is served over https. */
  readonly secureCookies: boolean;
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
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const describePerson = (found: { customer: Customer; person: Person }) => ({
  person: found.person,
  customer: { slug: found.customer.slug, name: found.customer.name },
});

/** The handler for every `/api` route; answers false for a path it does not serve. */
export function apiHandler(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  /** The latest conversation each person opened, by Acme's user id, for the presenter's drawer. */
  const conversations = new Map<string, string>();

  const sessionCookie = (personId: string) =>
    `${SESSION_COOKIE}=${encodeURIComponent(deps.sessions.issue(personId))}; Path=/; HttpOnly; SameSite=Strict${deps.secureCookies ? "; Secure" : ""}`;

  return async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (!path.startsWith("/api/")) return false;
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
      const body = await readJson(req);
      const verdict = deps.sessions.checkPasscode(typeof body.passcode === "string" ? body.passcode : "");
      if (verdict === "limited") {
        json(res, 429, { error: "Too many tries. Wait a minute." });
        return true;
      }
      if (verdict === "wrong") {
        json(res, 401, { error: "That passcode is not Acme's." });
        return true;
      }
      const found = typeof body.personId === "string" ? personById(body.personId) : undefined;
      if (!found) {
        json(res, 404, { error: "No such person." });
        return true;
      }
      json(res, 200, describePerson(found), { "set-cookie": sessionCookie(found.person.id) });
      return true;
    }

    const signedInId = deps.sessions.verify(cookie(req, SESSION_COOKIE));
    const who = signedInId ? personById(signedInId) : undefined;

    if (route === "GET /api/me") {
      json(res, 200, who ? { signedIn: true, ...describePerson(who) } : { signedIn: false });
      return true;
    }

    if (!who) {
      json(res, 401, { error: "Sign in to Acme Books first." });
      return true;
    }

    if (route === "POST /api/switch") {
      const body = await readJson(req);
      const found = typeof body.personId === "string" ? personById(body.personId) : undefined;
      if (!found) json(res, 404, { error: "No such person." });
      else json(res, 200, describePerson(found), { "set-cookie": sessionCookie(found.person.id) });
      return true;
    }

    if (route === "POST /api/sign-out") {
      json(res, 200, {}, { "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
      return true;
    }

    if (route === "GET /api/token") {
      try {
        const { accessToken, expiresAt } = await deps.mint(who.customer, who.person);
        json(res, 200, { accessToken, expiresAt: expiresAt.toISOString() });
      } catch (error) {
        json(res, 502, { error: `Stigmer refused the token: ${error instanceof Error ? error.message : String(error)}` });
      }
      return true;
    }

    if (route === "GET /api/ledger") {
      json(res, 200, deps.books.view(who.customer));
      return true;
    }

    if (route === "POST /api/conversations") {
      const body = await readJson(req);
      if (typeof body.sessionId !== "string" || body.sessionId === "") {
        json(res, 400, { error: "Name the conversation." });
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
