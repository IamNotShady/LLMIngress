// Server-side pagination helpers for the console list pages. Pagination state
// lives entirely in the URL (?page=N) so pages stay server-rendered, stable, and
// bookmarkable, and work without client JS.

export type ConsoleSearchParams = Record<string, string | string[] | undefined>;

export type PageView<T> = {
  items: T[];
  page: number;
  totalPages: number;
  total: number;
  /** 1-based index of the first item on this page (0 when empty). */
  from: number;
  /** 1-based index of the last item on this page (0 when empty). */
  to: number;
};

function readSingleParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function readPageParam(searchParams: ConsoleSearchParams, param = "page"): number {
  const raw = Number.parseInt(readSingleParam(searchParams[param]) ?? "1", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/**
 * Builds an href that keeps the current query string while applying `overrides`.
 * A value of undefined / null / "" removes that param. Returned as a query-only
 * string so it resolves against the current pathname.
 */
export function buildQueryHref(
  searchParams: ConsoleSearchParams,
  overrides: Record<string, string | number | undefined | null>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    const single = readSingleParam(value);
    if (single !== undefined && single !== "") {
      params.set(key, single);
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null || value === "") {
      params.delete(key);
    } else {
      params.set(key, String(value));
    }
  }
  const query = params.toString();
  return query ? `?${query}` : "?";
}
