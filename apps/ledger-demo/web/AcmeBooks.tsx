/**
 * Acme Books: a customer's ledger on the left, Stigmer's chat panel docked on the right, the way an
 * integrator puts an agent in its product.
 *
 * Acme's sign-in (a demo passcode, then a person) and the account switcher stand in for Acme's own
 * sign-in: Acme's server keeps who is signed in, in a signed cookie. On a switch the panel remounts
 * with a new client whose token cache asks `/api/token` for that person's token, minted into their
 * own customer's organization. The Agent lives in Acme's organization and is shared with every customer's, so
 * the panel names the Agent by Acme's organization and the conversation by the customer's.
 *
 * The page opens as Acme Books was before Stigmer: no Assistant. The presenter adds Stigmer from the
 * drawer, and the Assistant arrives with a card showing the one component Acme's page added, so a
 * demo shows the product without an agent first and what it took to give it one. This browser
 * remembers the choice; "Start the quarter over" takes Stigmer out again for the next viewer.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createTokenCache, Stigmer } from "@stigmer/client";
import { AgentChat, StigmerProvider } from "@stigmer/react-sdk/chat";
import { Sparkles } from "lucide-react";
import { api, type AppConfig } from "./api.js";
import { Ledger } from "./Ledger.js";
import { PresenterDrawer } from "./PresenterDrawer.js";
import { SignIn } from "./SignIn.js";

const ADDED_KEY = "acme-books:stigmer-added";

function rememberedAdded(): boolean {
  try {
    return window.localStorage.getItem(ADDED_KEY) === "yes";
  } catch {
    return false;
  }
}

function rememberAdded(added: boolean): void {
  try {
    window.localStorage.setItem(ADDED_KEY, added ? "yes" : "no");
  } catch {
    // Storage refused (a private window): the choice lasts until the page reloads.
  }
}

export function AcmeBooks() {
  const [config, setConfig] = useState<AppConfig>();
  const [personId, setPersonId] = useState<string>();
  const [signedIn, setSignedIn] = useState<boolean>();
  // The assistant starts closed: Acme's page comes first, and opening the assistant is the moment the
  // product shows what it has inside. Closed, the panel stays mounted, so a turn keeps running.
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [stigmerAdded, setStigmerAdded] = useState(rememberedAdded);
  // The card showing what Acme added: up from the moment Stigmer is added until the Assistant opens.
  const [showAdded, setShowAdded] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void (async () => {
      setConfig(await api.config());
      const me = await api.me();
      setSignedIn(me.signedIn);
      if (me.signedIn) setPersonId(me.person.id);
    })().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const addStigmer = useCallback((added: boolean) => {
    rememberAdded(added);
    setStigmerAdded(added);
    setShowAdded(added);
    if (!added) setAssistantOpen(false);
  }, []);

  const switchTo = useCallback(async (id: string) => {
    await api.switchTo(id);
    setPersonId(id);
  }, []);

  // One client per signed-in person: a new person never reuses the last one's cached token.
  const client = useMemo(() => {
    if (!config || !personId) return undefined;
    const tokens = createTokenCache(() => api.token());
    return new Stigmer({ baseUrl: config.stigmerUrl, getAccessToken: tokens.getAccessToken });
  }, [config, personId]);

  if (error) return <div className="acme-fatal">Acme Books could not start: {error}</div>;
  if (!config || signedIn === undefined) return <div className="acme-loading">Loading…</div>;
  if (!signedIn || !personId) {
    return (
      <SignIn
        config={config}
        onSignedIn={(id) => {
          setSignedIn(true);
          setPersonId(id);
        }}
      />
    );
  }
  if (!client) return <div className="acme-loading">Loading…</div>;
  const person = config.people.find((p) => p.id === personId);
  if (!person) return <div className="acme-fatal">Unknown person {personId}.</div>;

  return (
    <div className="acme">
      <header className="acme-bar">
        <div className="acme-brand">
          <span className="acme-mark" aria-hidden>
            A
          </span>
          Acme Books
        </div>
        <nav className="acme-nav" aria-label="Sections">
          <span className="acme-nav-item is-current">Ledger</span>
          <span className="acme-nav-item">Invoices</span>
          <span className="acme-nav-item">Reports</span>
        </nav>
        {stigmerAdded && (
          <button
            type="button"
            className={[
              "acme-button acme-assistant-toggle",
              assistantOpen ? "is-open" : "",
              showAdded ? "is-new" : "",
            ].join(" ")}
            aria-pressed={assistantOpen}
            onClick={() => {
              setShowAdded(false);
              setAssistantOpen((o) => !o);
            }}
          >
            <Sparkles className="acme-icon" aria-hidden />
            Assistant
          </button>
        )}
        <label className="acme-account">
          <span className="acme-visually-hidden">Signed in as</span>
          <select value={personId} onChange={(e) => void switchTo(e.target.value)}>
            {config.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.customer.name}
              </option>
            ))}
          </select>
        </label>
      </header>
      {stigmerAdded && showAdded && (
        <div className="acme-added" role="status">
          <div className="acme-added-head">
            <strong>Stigmer, added to Acme Books</strong>
            <button type="button" className="acme-link" aria-label="Close" onClick={() => setShowAdded(false)}>
              Close
            </button>
          </div>
          <p>The one component Acme’s page added:</p>
          <pre>{`<AgentChat
  agent={{
    org: "${config.agent.org}",
    slug: "${config.agent.slug}",
  }}
  org="${person.customer.slug}"
/>`}</pre>
        </div>
      )}
      <main className={stigmerAdded && assistantOpen ? "acme-main" : "acme-main is-assistant-closed"}>
        <Ledger key={personId} />
        <aside className="acme-panel" aria-label="Assistant">
          <StigmerProvider key={personId} client={client}>
            <AgentChat
              variant="panel"
              open={assistantOpen}
              onOpenChange={setAssistantOpen}
              agent={{ org: config.agent.org, slug: config.agent.slug }}
              org={person.customer.slug}
              title="Assistant"
              placeholder="Ask about this quarter…"
              onSessionChange={(sessionId) => {
                if (sessionId) void api.rememberConversation(sessionId);
              }}
            />
          </StigmerProvider>
        </aside>
      </main>
      <PresenterDrawer
        client={client}
        config={config}
        personId={personId}
        stigmerAdded={stigmerAdded}
        onStigmerAdded={addStigmer}
      />
    </div>
  );
}
