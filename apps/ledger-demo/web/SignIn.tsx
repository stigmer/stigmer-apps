/**
 * Acme Books' sign-in: the demo passcode and which of Acme's people to be. It stands in for an
 * integrator's real sign-in; Acme's server checks the passcode and keeps who is signed in.
 */
import { useState, type FormEvent } from "react";
import { api, type AppConfig } from "./api.js";

export function SignIn({ config, onSignedIn }: { config: AppConfig; onSignedIn: (personId: string) => void }) {
  const [personId, setPersonId] = useState(config.people[0]?.id ?? "");
  const [passcode, setPasscode] = useState("");
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(undefined);
    const result = await api.signIn(personId, passcode);
    setBusy(false);
    if (result.ok) onSignedIn(personId);
    else setProblem(result.reason);
  };

  return (
    <div className="acme-signin">
      <form className="acme-signin-card" onSubmit={(e) => void submit(e)}>
        <div className="acme-brand">
          <span className="acme-mark" aria-hidden>
            A
          </span>
          Acme Books
        </div>
        <label>
          Sign in as
          <select value={personId} onChange={(e) => setPersonId(e.target.value)}>
            {config.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.customer.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Passcode
          <input type="password" autoComplete="current-password" value={passcode} onChange={(e) => setPasscode(e.target.value)} autoFocus />
        </label>
        {problem && <p className="acme-problem">{problem}</p>}
        <button type="submit" className="acme-button acme-primary" disabled={busy || passcode === ""}>
          Sign in
        </button>
      </form>
    </div>
  );
}
