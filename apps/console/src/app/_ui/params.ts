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
 * Preserve the rest of the query string so a navigation never silently drops a
 * filter. Toast parameters are always dropped — a toast belongs to the action
 * that produced it, not to every later link.
 */
export function buildHref(
  pathname: string,
  params: SearchParams,
  changes: Record<string, string | null> = {},
): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const single = Array.isArray(value) ? value[0] : value;
    if (single !== undefined && single !== "" && !key.startsWith("toast")) {
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
