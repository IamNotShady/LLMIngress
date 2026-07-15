import { buildQueryHref, type ConsoleSearchParams } from "../_lib/pagination";

export function Pagination({
  ariaLabel,
  from,
  itemLabel,
  page,
  pageParam = "page",
  searchParams,
  to,
  total,
  totalPages,
}: {
  ariaLabel: string;
  from?: number;
  itemLabel: string;
  page: number;
  pageParam?: string;
  searchParams: ConsoleSearchParams;
  to?: number;
  total: number;
  totalPages: number;
}) {
  if (total === 0) {
    return null;
  }

  const hasPrevious = page > 1;
  const hasNext = page < totalPages;
  const previousHref = buildQueryHref(searchParams, {
    [pageParam]: page - 1 <= 1 ? undefined : page - 1,
  });
  const nextHref = buildQueryHref(searchParams, { [pageParam]: page + 1 });
  const rangeLabel =
    from !== undefined && to !== undefined
      ? `${from}\u2013${to} of ${total} ${itemLabel}`
      : `${total} ${itemLabel}`;

  return (
    <nav aria-label={ariaLabel} className="list-pagination">
      <p className="list-pagination-summary">
        <strong>
          Page {page} of {totalPages}
        </strong>
        <span className="list-pagination-range">{rangeLabel}</span>
      </p>
      <div className="list-pagination-controls">
        {hasPrevious ? (
          <a
            aria-label="Previous page"
            className="list-pagination-link"
            href={previousHref}
            rel="prev"
          >
            <span aria-hidden="true">&larr;</span>
            <span>Previous</span>
          </a>
        ) : (
          <button
            aria-label="Previous page"
            className="list-pagination-link"
            disabled
            type="button"
          >
            <span aria-hidden="true">&larr;</span>
            <span>Previous</span>
          </button>
        )}
        {hasNext ? (
          <a aria-label="Next page" className="list-pagination-link" href={nextHref} rel="next">
            <span>Next</span>
            <span aria-hidden="true">&rarr;</span>
          </a>
        ) : (
          <button aria-label="Next page" className="list-pagination-link" disabled type="button">
            <span>Next</span>
            <span aria-hidden="true">&rarr;</span>
          </button>
        )}
      </div>
    </nav>
  );
}
