/** The router's designed miss — orientation, not a dead end. */

import { Link } from "react-router-dom";

export function NotFoundScreen() {
  return (
    <section aria-label="Page not found" className="py-12 text-center">
      <h1 className="mb-2 text-lg font-semibold">This page doesn't exist</h1>
      <p className="text-ink-muted">
        The link may be old.{" "}
        <Link to="/" className="text-brand underline">
          Go to your tasks
        </Link>
        .
      </p>
    </section>
  );
}
