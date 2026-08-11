/**
 * Server-side pagination controls (D3): page size is the contract's 20,
 * total_count is the server's — this component never sees more rows than
 * the page it renders.
 */

import { PAGE_SIZE } from "../lib/contract.js";
import { Button } from "./Button.js";

export function Pagination(props: {
  page: number;
  totalCount: number;
  onPage: (page: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(props.totalCount / PAGE_SIZE));
  if (pageCount <= 1) return null;
  return (
    <nav aria-label="Pagination" className="mt-3 flex items-center justify-between text-sm">
      <Button disabled={props.page === 0} onClick={() => props.onPage(props.page - 1)}>
        ← Previous
      </Button>
      <span className="text-ink-muted">
        Page {props.page + 1} of {pageCount}
      </span>
      <Button
        disabled={props.page >= pageCount - 1}
        onClick={() => props.onPage(props.page + 1)}
      >
        Next →
      </Button>
    </nav>
  );
}
