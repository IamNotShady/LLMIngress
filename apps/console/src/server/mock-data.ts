// Deterministic placeholder data for console fields the backend does not yet
// expose. Every value is derived from a stable string seed so the UI (and its
// E2E tests) render the same numbers on every request. All exports are named
// `placeholder*` so real-vs-fake data stays obvious and easy to swap out once
// the matching backend (feat-102..109) lands.

/** Stable 32-bit hash of a seed string. */
function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Deterministic pseudo-random number in [0, 1) for a seed + salt. */
function seededUnit(seed: string, salt: number): number {
  const hash = hashSeed(`${seed}:${salt}`);
  return (hash % 100000) / 100000;
}

/** Deterministic integer in [min, max]. */
export function placeholderInt(seed: string, min: number, max: number, salt = 0): number {
  return Math.floor(seededUnit(seed, salt) * (max - min + 1)) + min;
}

/** Deterministic float in [min, max] rounded to `decimals`. */
export function placeholderFloat(
  seed: string,
  min: number,
  max: number,
  decimals = 2,
  salt = 0,
): number {
  const value = seededUnit(seed, salt) * (max - min) + min;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export type PlaceholderTrendPoint = { label: string; requests: number; costUsd: number };

/**
 * A request/cost trend over the last `points` buckets, seeded so it stays
 * stable. Used by Overview and Usage charts until real time-series land.
 */
export function placeholderTrend(seed: string, points: number): PlaceholderTrendPoint[] {
  const result: PlaceholderTrendPoint[] = [];
  for (let index = 0; index < points; index += 1) {
    const requests = placeholderInt(seed, 800, 2400, index + 1);
    const costUsd = placeholderFloat(seed, 4, 18, 2, index + 100);
    result.push({ label: `${String(index + 1).padStart(2, "0")}`, requests, costUsd });
  }
  return result;
}
