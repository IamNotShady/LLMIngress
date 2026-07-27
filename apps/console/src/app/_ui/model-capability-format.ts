/**
 * A model's context window in the compact form the tables are laid out for
 * (`200k`, `400k`, `1M`) — the column is 104px wide and a grouped count wraps.
 *
 * The precision is the point: two candidates whose context windows differ fail
 * the route-policy capability contract, so `1,000,000` and `1,048,576` must not
 * render as the same string. Rounding to whole millions made both `1M`, which
 * is the bug this function exists not to have; two decimals keep them `1M` and
 * `1.05M`.
 */
export function formatModelContextTokens(contextWindow: number | null): string {
  if (contextWindow === null) {
    return "Unknown";
  }
  if (contextWindow >= 1_000_000) {
    return `${trimZeros((contextWindow / 1_000_000).toFixed(2))}M`;
  }
  if (contextWindow >= 1_000) {
    return `${trimZeros((contextWindow / 1_000).toFixed(1))}k`;
  }
  return String(contextWindow);
}

function trimZeros(value: string): string {
  return value.replace(/\.0+$/, "");
}
