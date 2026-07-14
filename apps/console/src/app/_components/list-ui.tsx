import type { ReactNode } from "react";

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
