import type { ReactNode } from "react";
import { buildQueryHref, type ConsoleSearchParams, type PageView } from "../_lib/pagination";

// Page-based pager: "from–to of total" with Prev/Next links that preserve the
// rest of the query string. Server-rendered <a> links; no client JS.
export function Pager({
  view,
  searchParams,
  pageParam = "page",
}: {
  view: PageView<unknown>;
  searchParams: ConsoleSearchParams;
  pageParam?: string;
}) {
  if (view.total === 0) return null;

  const hasPrev = view.page > 1;
  const hasNext = view.page < view.totalPages;
  const prevHref = buildQueryHref(searchParams, {
    [pageParam]: view.page - 1 <= 1 ? undefined : view.page - 1,
  });
  const nextHref = buildQueryHref(searchParams, { [pageParam]: view.page + 1 });

  return (
    <nav className="pager" aria-label="Pagination">
      <span className="pager-status">
        {view.from}&ndash;{view.to} of {view.total}
      </span>
      <span className="pager-controls">
        {hasPrev ? (
          <a className="pager-link" href={prevHref} rel="prev">
            &lsaquo; Prev
          </a>
        ) : (
          <span className="pager-link is-disabled" aria-disabled="true">
            &lsaquo; Prev
          </span>
        )}
        {hasNext ? (
          <a className="pager-link" href={nextHref} rel="next">
            Next &rsaquo;
          </a>
        ) : (
          <span className="pager-link is-disabled" aria-disabled="true">
            Next &rsaquo;
          </span>
        )}
      </span>
    </nav>
  );
}

// A collapsed list row. The summary stays visible (title + meta + status); the
// body (details, edit forms) is revealed on demand via the native disclosure.
export function Row({
  title,
  meta,
  status,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details className="row">
      <summary className="row-summary">
        <span className="row-caret" aria-hidden="true" />
        <span className="row-headline">
          {title}
          {meta ? <span className="row-meta">{meta}</span> : null}
        </span>
        {status ? <span className="row-status">{status}</span> : null}
      </summary>
      <div className="row-body">{children}</div>
    </details>
  );
}

// A standalone collapsible block, e.g. a "+ New …" create form or a heavy
// secondary panel. `tone="add"` styles the summary as a primary affordance.
export function Disclosure({
  summary,
  children,
  tone = "default",
  open = false,
}: {
  summary: ReactNode;
  children: ReactNode;
  tone?: "default" | "add";
  open?: boolean;
}) {
  return (
    <details className={`disclosure disclosure-${tone}`} open={open}>
      <summary className="disclosure-summary">
        <span className="row-caret" aria-hidden="true" />
        <span>{summary}</span>
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}
