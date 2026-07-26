import { readParam, type SearchParams } from "../params";

/**
 * The grants being edited travel in the query string, so a checkbox is a plain
 * link and the dialog stays server-rendered from what the operator has picked.
 *
 * An empty parameter cannot carry the empty set: `?grantIds=` reads as absent,
 * which is right for a filter (`?q=` is no filter) and the opposite of right
 * here — revoking the last grant would read as "the URL said nothing" and fall
 * back to the grants the key already has, so the save wrote them all again. The
 * empty set says so by name instead; a virtual model id is a UUID, so the word
 * can never be one.
 */
export const NO_GRANTS = "none";

/** The two parameters a grant toggle rewrites, always both of them. */
export function grantParamChanges(
  grantIds: readonly string[],
  defaultGrantId: string,
): { defaultGrant: string; grantIds: string } {
  return {
    defaultGrant: defaultGrantId === "" ? NO_GRANTS : defaultGrantId,
    grantIds: grantIds.length === 0 ? NO_GRANTS : grantIds.join(","),
  };
}

/** `saved` is what the key is granted now: the answer until the URL says. */
export function readGrantIds(params: SearchParams, saved: readonly string[]): string[] {
  const raw = readParam(params, "grantIds");
  if (raw === undefined) {
    return [...saved];
  }
  return raw === NO_GRANTS ? [] : raw.split(",").filter(Boolean);
}

export function readDefaultGrantId(params: SearchParams, saved: string): string {
  const raw = readParam(params, "defaultGrant");
  if (raw === undefined) {
    return saved;
  }
  return raw === NO_GRANTS ? "" : raw;
}
