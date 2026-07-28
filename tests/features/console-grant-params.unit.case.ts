import { describe, expect, it } from "vitest";
import {
  grantParamChanges,
  NO_GRANTS,
  readDefaultGrantId,
  readGrantIds,
} from "../../apps/console/src/app/_ui/api-keys/grant-params.ts";
import { buildHref, type SearchParams } from "../../apps/console/src/app/_ui/params.ts";

const SAVED = ["vm-a", "vm-b", "vm-c"];

/** What Next hands a page after the browser follows one of these links. */
function navigate(href: string): SearchParams {
  return Object.fromEntries(new URL(href, "http://console.test").searchParams);
}

/** One toggle: the link a grant checkbox points at, then the page it renders. */
function toggle(params: SearchParams, ids: string[], defaultGrantId: string) {
  const href = buildHref("/api-keys", params, grantParamChanges(ids, defaultGrantId));
  const next = navigate(href);
  return {
    defaultGrantId: readDefaultGrantId(next, "vm-a"),
    ids: readGrantIds(next, SAVED),
    params: next,
  };
}

describe("api key grant parameters", () => {
  it("keeps a set the operator emptied empty", () => {
    // An empty value cannot say "empty": ?grantIds= reads as absent, which is
    // right for a filter and the opposite of right for a set. Revoking the last
    // grant used to read as "the URL said nothing" and hand back every grant
    // the key already had — the save then wrote them all again.
    const revoked = toggle({ dialog: "edit", selected: "key-1" }, [], "");

    expect(revoked.params.grantIds).toBe(NO_GRANTS);
    expect(revoked.ids).toEqual([]);
    expect(revoked.defaultGrantId).toBe("");
  });

  it("carries the grants that are left", () => {
    const revoked = toggle({ dialog: "edit" }, ["vm-a", "vm-c"], "vm-a");

    expect(revoked.ids).toEqual(["vm-a", "vm-c"]);
    expect(revoked.defaultGrantId).toBe("vm-a");
  });

  it("clears the default without clearing the grants", () => {
    // Revoking the model that was the default leaves the others granted and the
    // key with no default: a stale default is not in the allowed set, and the
    // save is refused for a state the operator can no longer see.
    const revoked = toggle({ dialog: "edit" }, ["vm-b", "vm-c"], "");

    expect(revoked.params.defaultGrant).toBe(NO_GRANTS);
    expect(revoked.ids).toEqual(["vm-b", "vm-c"]);
    expect(revoked.defaultGrantId).toBe("");
  });

  it("falls back to the key's own grants only while the URL has not said anything", () => {
    const untouched: SearchParams = { dialog: "edit", grantQuery: "vm" };

    expect(readGrantIds(untouched, SAVED)).toEqual(SAVED);
    expect(readDefaultGrantId(untouched, "vm-b")).toBe("vm-b");
  });

  it("leaves a refusal behind with the submission that caused it", () => {
    // formError belongs to one save, not to every link after it: paging the
    // grants browser or searching it used to carry "the name is taken" along,
    // describing a submission the operator has already moved on from.
    const refused: SearchParams = {
      dialog: "new",
      formError: "That name is taken.",
      grantPage: "2",
    };
    const paged = navigate(buildHref("/api-keys", refused, { grantPage: "3" }));

    expect(paged.formError).toBeUndefined();
    expect(paged.grantPage).toBe("3");
    expect(paged.dialog).toBe("new");
  });

  it("survives the filters the browser applies alongside it", () => {
    const revoked = toggle({ dialog: "edit" }, [], "");
    const filtered = navigate(buildHref("/api-keys", revoked.params, { grantShow: "granted" }));

    expect(readGrantIds(filtered, SAVED)).toEqual([]);
    expect(readDefaultGrantId(filtered, "vm-a")).toBe("");
  });
});
