import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Tables are fixed pixel columns + gap. Long-text cells must carry cell-clip so
 * nothing wraps at the 1440px target width and every row keeps one height.
 */
/** Grid wrapper that owns the column widths for a head/row pair. */
export function GridRow({
  children,
  className = "",
  columns,
  gap = 12,
  head = false,
  href,
  selected = false,
}: {
  children: ReactNode;
  className?: string;
  columns: string;
  gap?: number;
  head?: boolean;
  href?: string;
  selected?: boolean;
}) {
  const style = { gridTemplateColumns: columns, gap };

  if (head) {
    return (
      <div
        style={style}
        className={`grid border-b border-hair py-[6px] font-mono text-115 font-medium tracking-[.08em] text-dim ${className}`}
      >
        {children}
      </div>
    );
  }

  const rowClass = `grid items-center border-b border-rule2 py-[7px] font-mono text-13 text-ink ${
    href ? "cursor-pointer border-l-2 hover:bg-[var(--pick-hover)]" : ""
  } ${
    selected ? "border-l-accent bg-[var(--pick-on)]" : href ? "border-l-transparent" : ""
  } ${className}`;

  if (href) {
    return (
      <Link href={href} style={style} className={rowClass}>
        {children}
      </Link>
    );
  }

  return (
    <div style={style} className={rowClass}>
      {children}
    </div>
  );
}

/** Left-hand master list entry: 2px accent edge + tinted background when picked. */
export function PickRow({
  children,
  href,
  selected,
}: {
  children: ReactNode;
  href: string;
  selected: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={selected ? "true" : undefined}
      className={`flex items-center gap-[9px] border-b border-rule2 border-l-2 px-2 py-[9px] hover:bg-[var(--pick-hover)] ${
        selected ? "border-l-accent bg-[var(--pick-on)]" : "border-l-transparent"
      }`}
    >
      {children}
    </Link>
  );
}

/**
 * Range label plus prev/next. Rendered only when there are rows — an empty
 * result shows its empty state with no pagination controls.
 */
export function Pagination({
  buildHref,
  page,
  pageCount,
  rangeLabel,
}: {
  buildHref: (page: number) => string;
  page: number;
  pageCount: number;
  rangeLabel: string;
}) {
  const hasPrev = page > 1;
  const hasNext = page < pageCount;
  const stepClass = "rounded-xs border border-btnbd bg-btnbg px-2 py-[2px]";

  return (
    <div className="mt-3 flex items-center gap-3 font-mono text-13 text-dim">
      <span>{rangeLabel}</span>
      <span className="ml-auto flex items-center gap-2">
        {hasPrev ? (
          <Link href={buildHref(page - 1)} className={`${stepClass} text-ink`}>
            ← Prev
          </Link>
        ) : (
          <span className={`${stepClass} text-faint`}>← Prev</span>
        )}
        {hasNext ? (
          <Link href={buildHref(page + 1)} className={`${stepClass} text-ink`}>
            Next →
          </Link>
        ) : (
          <span className={`${stepClass} text-faint`}>Next →</span>
        )}
      </span>
    </div>
  );
}

/** "1–20 of 318" — the same denominator the header count uses. */
export function formatRange(input: { page: number; pageSize: number; total: number }): string {
  if (input.total === 0) {
    return "0 of 0";
  }
  const first = (input.page - 1) * input.pageSize + 1;
  const last = Math.min(input.page * input.pageSize, input.total);
  return `${first}–${last} of ${input.total}`;
}
