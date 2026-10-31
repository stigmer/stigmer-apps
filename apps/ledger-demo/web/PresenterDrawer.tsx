/**
 * The presenter's drawer, hidden until Alt+D: one call made with the signed-in person's own Stigmer
 * token, asking for another customer's latest conversation by its id. The answer is shown exactly as
 * Stigmer's server words it (a refusal may say permission denied or not found; both keep the
 * conversation out of reach), so the walls are shown, not claimed.
 *
 * It also resets the quarter between rehearsals.
 */
import { useEffect, useState } from "react";
import type { Stigmer } from "@stigmer/client";
import { api, type AppConfig } from "./api.js";

type Answer = { readonly kind: "refused"; readonly code: string; readonly message: string } | { readonly kind: "answered"; readonly text: string };

function describe(error: unknown): Answer {
  const e = error as { code?: unknown; message?: unknown };
  return { kind: "refused", code: String(e.code ?? "error"), message: String(e.message ?? error) };
}

export function PresenterDrawer({ client, config, personId }: { client: Stigmer; config: AppConfig; personId: string }) {
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<Answer>();
  const [target, setTarget] = useState<{ owner: string; sessionId: string }>();
  const me = config.people.find((p) => p.id === personId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.code === "KeyD") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => setAnswer(undefined), [personId]);

  useEffect(() => {
    if (!open) return;
    void api.conversations().then((byPerson) => {
      const other = config.people.find((p) => p.customer.slug !== me?.customer.slug && byPerson[p.id]);
      setTarget(other ? { owner: `${other.name} · ${other.customer.name}`, sessionId: byPerson[other.id]! } : undefined);
    });
  }, [open, personId, config.people, me?.customer.slug]);

  if (!open) return null;

  const ask = async () => {
    if (!target) return;
    try {
      const session = await client.session.get(target.sessionId);
      setAnswer({ kind: "answered", text: `Stigmer returned the conversation (${session.metadata?.id ?? "?"}) — the walls did not hold.` });
    } catch (error) {
      setAnswer(describe(error));
    }
  };

  return (
    <div className="acme-drawer" role="dialog" aria-label="Presenter">
      <div className="acme-drawer-head">
        <strong>Presenter</strong>
        <button type="button" className="acme-link" onClick={() => setOpen(false)}>
          Close (Alt+D)
        </button>
      </div>
      <p>
        Signed in as <strong>{me ? `${me.name} · ${me.customer.name}` : personId}</strong>.
      </p>
      {target ? (
        <>
          <p>
            Ask Stigmer, with this person's token, for {target.owner}'s conversation <code>{target.sessionId}</code>.
          </p>
          <button type="button" className="acme-button" onClick={() => void ask()}>
            Ask for it
          </button>
        </>
      ) : (
        <p className="acme-empty">No other customer's conversation yet: start one as that customer first.</p>
      )}
      {answer && (
        <pre className="acme-answer">
          {answer.kind === "refused" ? `Stigmer's server answered: ${answer.code}\n${answer.message}` : answer.text}
        </pre>
      )}
      <hr />
      <button type="button" className="acme-link" onClick={() => void api.reset()}>
        Start the quarter over (rehearsals)
      </button>
    </div>
  );
}
