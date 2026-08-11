/**
 * Account activation (DD-003 D4) — anonymous, beside /login: the person
 * types the code their managing partner handed them and chooses their
 * OWN password; nobody else ever knows it. Also the reset path — the
 * same code mechanism, the same screen.
 *
 * The code prefills from ?code=… so an administrator can share a
 * ready-to-open link; the password never rides a URL.
 */

import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ConnectError } from "@connectrpc/connect";
import { useSessionKit } from "../../session/use-session.js";

export function ActivateScreen() {
  const kit = useSessionKit();
  const [searchParams] = useSearchParams();
  const [code, setCode] = useState(searchParams.get("code") ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    if (password !== confirm) {
      setError("The passwords do not match");
      return;
    }
    setPending(true);
    try {
      await kit.redeemActivationCode(code.trim(), password);
      setDone(true);
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
        <p className="mb-6 text-center text-ink-muted">Set your password</p>

        {done ? (
          <div
            role="status"
            className="rounded-card border border-line bg-surface p-6 text-center shadow-sm"
          >
            <p className="mb-4">Your password is set.</p>
            <Link
              to="/login"
              className="inline-flex h-11 items-center rounded-card bg-brand px-4 font-medium text-on-brand hover:bg-brand-strong"
            >
              Sign in
            </Link>
          </div>
        ) : (
          <form
            onSubmit={onSubmit}
            className="rounded-card border border-line bg-surface p-6 shadow-sm"
            aria-label="Set your password"
          >
            <label htmlFor="activation-code" className="mb-1 block text-sm font-medium">
              Activation code
            </label>
            <input
              id="activation-code"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="act_…"
              className="mb-1 block h-11 w-full rounded-card border border-line bg-surface px-3 font-mono"
            />
            <p className="mb-4 text-sm text-ink-muted">
              The code your managing partner shared with you.
            </p>

            <label htmlFor="new-password" className="mb-1 block text-sm font-medium">
              Choose a password
            </label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mb-4 block h-11 w-full rounded-card border border-line bg-surface px-3"
            />

            <label htmlFor="confirm-password" className="mb-1 block text-sm font-medium">
              Repeat the password
            </label>
            <input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
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
              {pending ? "Setting your password…" : "Set password"}
            </button>
          </form>
        )}

        <p className="mt-4 text-center text-sm text-ink-muted">
          Already have a password?{" "}
          <Link to="/login" className="text-brand underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
