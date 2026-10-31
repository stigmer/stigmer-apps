/**
 * Acme Books: a customer's ledger on the left, Stigmer's chat panel docked on the right, the way an
 * integrator puts an agent in its product.
 *
 * The account switcher is the page's stand-in for Acme's own sign-in: switching posts the person to
 * Acme's server, which keeps who is signed in. The panel then remounts with a new client whose
 * token cache asks `/api/token` for that person's token, minted into their own customer's
 * organization. The Agent lives in Acme's organization and is shared with every customer's, so
 * the panel names the Agent by Acme's organization and the conversation by the customer's.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createTokenCache, Stigmer } from "@stigmer/client";
import { AgentChat, StigmerProvider } from "@stigmer/react-sdk/chat";
import { api, type AppConfig } from "./api.js";
import { Ledger } from "./Ledger.js";
import { PresenterDrawer } from "./PresenterDrawer.js";

export function AcmeBooks() {
  const [config, setConfig] = useState<AppConfig>();
  const [personId, setPersonId] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void (async () => {
      const loaded = await api.config();
      setConfig(loaded);
      let me = await api.me();
      if (!me) {
        me = loaded.people[0]?.id;
        if (me) await api.signIn(me);
      }
      setPersonId(me);
    })().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const switchTo = useCallback(async (id: string) => {
    await api.signIn(id);
    setPersonId(id);
  }, []);

  // One client per signed-in person: a new person never reuses the last one's cached token.
  const client = useMemo(() => {
    if (!config || !personId) return undefined;
    const tokens = createTokenCache(() => api.token());
    return new Stigmer({ baseUrl: config.stigmerUrl, getAccessToken: tokens.getAccessToken });
  }, [config, personId]);

  if (error) return <div className="acme-fatal">Acme Books could not start: {error}</div>;
  if (!config || !personId || !client) return <div className="acme-loading">Loading…</div>;
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
      <main className="acme-main">
        <Ledger key={personId} />
        <aside className="acme-panel" aria-label="Assistant">
          <StigmerProvider key={personId} client={client}>
            <AgentChat
              variant="panel"
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
      <PresenterDrawer client={client} config={config} personId={personId} />
    </div>
  );
}
