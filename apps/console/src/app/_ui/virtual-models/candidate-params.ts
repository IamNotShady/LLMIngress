import { readParam, type SearchParams } from "../params";

/**
 * The candidates being edited travel in the query string, so reordering and
 * removing are plain links and the editor stays server-rendered from what the
 * operator has picked.
 *
 * An empty parameter cannot carry the empty set: `?candidates=` reads as absent,
 * which is right for a filter and the opposite of right here — removing the last
 * candidate would read as "the URL said nothing" and fall back to the candidates
 * the route already has, so the whole original set came back. The empty set says
 * so by name instead; a provider model id is a UUID, so the word can never be
 * one. The same shape the grants picker uses.
 */
export const NO_CANDIDATES = "none";

/** The parameter a candidate add, remove or reorder rewrites. */
export function candidateParamChange(providerModelIds: readonly string[]): string {
  return providerModelIds.length === 0 ? NO_CANDIDATES : providerModelIds.join(",");
}

/** `saved` is what the route holds now: the answer until the URL says. */
export function readCandidateSelection(params: SearchParams, saved: readonly string[]): string[] {
  const raw = readParam(params, "candidates");
  if (raw === undefined) {
    return [...saved];
  }
  return raw === NO_CANDIDATES ? [] : raw.split(",").filter(Boolean);
}
