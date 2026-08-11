/**
 * Sign-in (FR-AUTH-001 as adapted by T01 owner decision 1: email/password
 * only — no self-registration, no reset flow; reset is an operator
 * action, so the screen deliberately offers neither link).
 *
 * Error discipline: server sentences are shown verbatim — the uniform
 * login failure ("Email or password is incorrect", DD-005's recorded
 * exception), the rate-limit answer with its retry time, and any
 * session-end notice carried over from the session kit (e.g. the theft
 * response). The screen never invents its own security wording.
 */

import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { ConnectError } from "@connectrpc/connect";
import { useSessionKit, useSessionState } from "../../session/use-session.js";

export function LoginScreen() {
  const kit = useSessionKit();
  const state = useSessionState();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  if (state.status === "signed-in") {
    return <Navigate to="/" replace />;
  }
  const notice = state.status === "signed-out" ? state.notice : undefined;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      await kit.signIn(email, password);
      // Signed-in state flips the router via the <Navigate> above.
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-center text-2xl font-semibold">Stigmer Law</h1>
        <p className="mb-6 text-center text-ink-muted">Sign in to your firm's workspace</p>

        {notice && (
          <p
            role="status"
            className="mb-4 rounded-card border border-line bg-warn-surface px-4 py-3 text-sm"
          >
            {notice}
          </p>
        )}

        <form
          onSubmit={onSubmit}
          className="rounded-card border border-line bg-surface p-6 shadow-sm"
          aria-label="Sign in"
        >
          <label htmlFor="email" className="mb-1 block text-sm font-medium">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mb-4 block h-11 w-full rounded-card border border-line bg-surface px-3"
          />

          <label htmlFor="password" className="mb-1 block text-sm font-medium">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mb-4 block h-11 w-full rounded-card border border-line bg-surface px-3"
          />

          {error && (
            <p role="alert" className="mb-4 rounded-card bg-danger-surface px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={pending}
            className="h-11 w-full rounded-card bg-brand font-medium text-on-brand hover:bg-brand-strong disabled:opacity-60"
          >
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-ink-muted">
          Forgot your password? Ask your managing partner for an activation code, then{" "}
          <a href="/activate" className="text-brand underline">
            set a new one
          </a>
          .
        </p>
      </div>
    </main>
  );
}
