/**
 * Where a jump between modules lands.
 *
 * Every one of these links sits next to a subject — this key, this virtual
 * model, these failures — and the page it opens can filter by exactly that. A
 * link that arrives unfiltered makes the operator re-pick by hand what the
 * console already knew they meant, and on a busy install the row they came for
 * is not even on the first page.
 *
 * The parameter names are the ones the two pages read, so this is the only
 * place that has to agree with them.
 */

export type ActivityLinkFilters = {
  apiKeyId?: string;
  providerId?: string;
  /** "failed" for the links that hang off a failure count. */
  status?: string;
  virtualModelId?: string;
  /** One of the Activity windows; omitted means its default of 24h. */
  window?: string;
};

export function activityHref(filters: ActivityLinkFilters = {}): string {
  const query = new URLSearchParams();
  const entries: Array<[string, string | undefined]> = [
    ["apiKey", filters.apiKeyId],
    ["provider", filters.providerId],
    ["status", filters.status],
    ["virtualModel", filters.virtualModelId],
    ["window", filters.window],
  ];
  for (const [key, value] of entries) {
    if (value) {
      query.set(key, value);
    }
  }
  const search = query.toString();
  return search ? `/activity?${search}` : "/activity";
}

/**
 * The key's own rules: the list is narrowed to it and its drawer is open, which
 * is the same place the Limits page lands on after saving.
 */
export function limitsHref(apiKey: { id: string; name: string }): string {
  const query = new URLSearchParams({ q: apiKey.name, selected: apiKey.id });
  return `/limits?${query.toString()}`;
}

/** Activity keeps a shorter horizon than Usage; 30d has no counterpart. */
export function activityWindowForUsageWindow(window: string): string {
  return window === "7d" || window === "30d" ? "7d" : "24h";
}
