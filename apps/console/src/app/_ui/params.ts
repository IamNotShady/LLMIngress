// Filter, selection and dialog state all live in the query string, so every
// view is server-rendered from the URL and a link is enough to open a dialog,
// change a page or pick a row.

export type SearchParams = Record<string, string | string[] | undefined>;

export function readParam(params: SearchParams, key: string): string | undefined {
  const value = params[key];
  const single = Array.isArray(value) ? value[0] : value;
  return single === "" ? undefined : single;
}

export function readIntParam(params: SearchParams, key: string, fallback: number): number {
  const parsed = Number.parseInt(readParam(params, key) ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * A page size arrives in the URL, so it is bounded where it is read rather than
 * where it is displayed: the query is what a hand-written 100000 would make
 * materialise the whole table for.
 */
export function readPageSizeParam(
  params: SearchParams,
  key: string,
  fallback: number,
  max = 100,
): number {
  return Math.min(max, readIntParam(params, key, fallback));
}

/**
 * Preserve the rest of the query string so a navigation never silently drops a
 * filter. Toast and refusal parameters are always dropped — both belong to the
 * action that produced them, not to every later link: a "the name is taken"
 * banner that follows the operator through paging and searching is describing a
 * submission they have already moved on from.
 */
export function buildHref(
  pathname: string,
  params: SearchParams,
  changes: Record<string, string | null> = {},
): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const single = Array.isArray(value) ? value[0] : value;
    if (single !== undefined && single !== "" && !key.startsWith("toast") && key !== "formError") {
      next.set(key, single);
    }
  }
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
  }
  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
}
