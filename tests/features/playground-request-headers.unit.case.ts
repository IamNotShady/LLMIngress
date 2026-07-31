import { readFileSync } from "node:fs";
import { readConsoleActivityRouteTag } from "@llmingress/db/console-activity";
import { describe, expect, it } from "vitest";
import {
  buildPlaygroundHeaders,
  describePlaygroundRouteTag,
  formatPlaygroundHeaderIssue,
  playgroundHeaderOptions,
  playgroundSendableHeaders,
} from "../../apps/console/src/app/_ui/playground/helpers.ts";

const read = (path: string) => readFileSync(path, "utf8");

// Sendable but never offered: a row naming any of these would do nothing.
// authorization, content-type and x-request-id are filled by the form itself
// and spread over any picked value; x-api-key is the gateway's keyless auth
// fallback, ignored while the form's Bearer key is present and never
// forwarded upstream.
const deadPickerNames = ["authorization", "content-type", "x-request-id", "x-api-key"];

describe("the header names a Playground row may pick from", () => {
  it("offers every sendable header a picked row could actually deliver", () => {
    for (const name of deadPickerNames) {
      expect(playgroundHeaderOptions).not.toContain(name);
    }
    expect([...playgroundHeaderOptions].sort()).toEqual(
      playgroundSendableHeaders.filter((name) => !deadPickerNames.includes(name)).sort(),
    );
  });

  it("leads with the tag header and keeps the allowlist order behind it", () => {
    // The one header this page exists to send is the one a new row starts on.
    expect(playgroundHeaderOptions[0]).toBe("x-llmingress-route-tag");
    expect(playgroundHeaderOptions.slice(1)).toEqual(
      playgroundSendableHeaders.filter(
        (name) => !deadPickerNames.includes(name) && name !== "x-llmingress-route-tag",
      ),
    );
  });
});

describe("the headers a Playground request may carry", () => {
  it("sends one row as one header, with the value trimmed and otherwise left alone", () => {
    expect(buildPlaygroundHeaders([{ name: "x-llmingress-route-tag", value: " fast " }])).toEqual({
      headers: { "x-llmingress-route-tag": "fast" },
      issues: [],
    });
  });

  it("sends every row it was given", () => {
    expect(
      buildPlaygroundHeaders([
        { name: "x-llmingress-route-tag", value: "fast" },
        { name: "x-client-request-id", value: "req:1:2" },
        { name: "anthropic-beta", value: "tools-2024-04-04" },
      ]),
    ).toEqual({
      headers: {
        "anthropic-beta": "tools-2024-04-04",
        "x-client-request-id": "req:1:2",
        "x-llmingress-route-tag": "fast",
      },
      issues: [],
    });
  });

  it("keeps the first row that names a header and marks the ones repeating it", () => {
    // Two rows for one header is not a merge and not a silent overwrite: the
    // second one is a row the operator has to decide about.
    expect(
      buildPlaygroundHeaders([
        { name: "x-llmingress-route-tag", value: "fast" },
        { name: "x-client-request-id", value: "req-1" },
        { name: "x-llmingress-route-tag", value: "cheap" },
      ]),
    ).toEqual({
      headers: { "x-client-request-id": "req-1", "x-llmingress-route-tag": "fast" },
      issues: [{ name: "x-llmingress-route-tag", reason: "duplicate", row: 3 }],
    });
  });

  it("refuses a row with no value rather than sending an empty header", () => {
    expect(
      buildPlaygroundHeaders([
        { name: "x-llmingress-route-tag", value: "" },
        { name: "x-client-request-id", value: "   " },
      ]),
    ).toEqual({
      headers: {},
      issues: [
        { name: "x-llmingress-route-tag", reason: "empty_value", row: 1 },
        { name: "x-client-request-id", reason: "empty_value", row: 2 },
      ],
    });
  });

  it("refuses a value the browser cannot put on the wire", () => {
    // fetch refuses to build a request with a header value outside printable
    // ASCII, and says so as a thrown TypeError with no field named.
    expect(buildPlaygroundHeaders([{ name: "x-llmingress-route-tag", value: "值" }])).toEqual({
      headers: {},
      issues: [{ name: "x-llmingress-route-tag", reason: "invalid_value", row: 1 }],
    });
  });

  it("normalizes the name it was handed, and refuses one the picker cannot produce", () => {
    expect(buildPlaygroundHeaders([{ name: " X-LLMIngress-Route-Tag ", value: "fast" }])).toEqual({
      headers: { "x-llmingress-route-tag": "fast" },
      issues: [],
    });
    // Not reachable from the picker; kept so a name from anywhere else is
    // refused rather than sent into a preflight that will not allow it.
    expect(buildPlaygroundHeaders([{ name: "x-custom", value: "1" }])).toEqual({
      headers: {},
      issues: [{ name: "x-custom", reason: "invalid_value", row: 1 }],
    });
  });

  it("has nothing to send and nothing to complain about with no rows", () => {
    expect(buildPlaygroundHeaders([])).toEqual({ headers: {}, issues: [] });
  });
});

describe("what a refused header row says", () => {
  it("names the row and tells the operator what to change", () => {
    expect(
      formatPlaygroundHeaderIssue({
        name: "x-llmingress-route-tag",
        reason: "empty_value",
        row: 1,
      }),
    ).toBe("row 1: x-llmingress-route-tag has no value — fill it in or remove the row");
    expect(
      formatPlaygroundHeaderIssue({
        name: "x-client-request-id",
        reason: "invalid_value",
        row: 2,
      }),
    ).toBe("row 2: x-client-request-id has a value the browser cannot send — printable ASCII only");
    expect(
      formatPlaygroundHeaderIssue({ name: "x-llmingress-route-tag", reason: "duplicate", row: 3 }),
    ).toBe(
      "row 3: x-llmingress-route-tag is already set on a row above — remove this row or pick another header",
    );
  });

  it("no longer has a wording for a mistake a picker cannot make", () => {
    // The name is picked, never typed: there is no line to malform, no header
    // outside the allowlist to reach for, and no form-owned name to collide
    // with. The three wordings that existed for those are gone with them.
    const helpers = read("apps/console/src/app/_ui/playground/helpers.ts");
    expect(helpers).not.toContain("use name: value");
    expect(helpers).not.toContain("is sent from the API KEY field");
    expect(helpers).not.toContain("is fixed at application/json");
    expect(helpers).not.toContain("is not in the gateway CORS allowlist");
  });
});

describe("the route tag the trace shows", () => {
  it("says which tag the request landed on, or how it failed to", () => {
    expect(describePlaygroundRouteTag(null)).toBe("—");
    expect(describePlaygroundRouteTag(undefined)).toBe("—");
    expect(
      describePlaygroundRouteTag({ matchedTag: "fast", requestedTag: "fast", tagFallback: false }),
    ).toBe("fast");
    // Asked for, matched nothing, served anyway: a silent fallback is the one
    // outcome a response body cannot tell you about.
    expect(
      describePlaygroundRouteTag({ matchedTag: null, requestedTag: "fast", tagFallback: true }),
    ).toBe("fast → default (no match)");
    expect(
      describePlaygroundRouteTag({ matchedTag: null, requestedTag: null, tagFallback: true }),
    ).toBe("no tag → default");
  });
});

describe("the tag the gateway recorded", () => {
  it("reads what the route reason wrote about the tag", () => {
    expect(
      readConsoleActivityRouteTag({
        matchedTag: "fast",
        message: 'tag route for tag-vm selected candidate 2 for tag "fast".',
        requestedTag: "fast",
        tagFallback: false,
      }),
    ).toEqual({ matchedTag: "fast", requestedTag: "fast", tagFallback: false });

    expect(
      readConsoleActivityRouteTag({
        message: "tag route for tag-vm fell back to default candidate 1",
        requestedTag: "fast",
        tagFallback: true,
      }),
    ).toEqual({ matchedTag: null, requestedTag: "fast", tagFallback: true });

    expect(readConsoleActivityRouteTag({ message: "no tag named", tagFallback: true })).toEqual({
      matchedTag: null,
      requestedTag: null,
      tagFallback: true,
    });
  });

  it("has nothing to say about a route that is not a tag route", () => {
    expect(readConsoleActivityRouteTag({ message: "cost_first route for caps-vm" })).toBeNull();
    expect(readConsoleActivityRouteTag(null)).toBeNull();
    expect(readConsoleActivityRouteTag("tag")).toBeNull();
    expect(readConsoleActivityRouteTag({ requestedTag: 7, tagFallback: "yes" })).toBeNull();
  });
});

describe("the allowlist the Playground copies", () => {
  it("names exactly the headers the gateway lets a browser send", () => {
    // The gateway is not changed by this feature, so the copy is what can
    // drift. This reads the one literal the gateway answers preflights with:
    // change that list and this line is the first thing that fails.
    const cors = read("apps/gateway/src/cors.ts");
    const allowed = cors.match(/"access-control-allow-headers":\s*"([^"]+)"/);

    expect(
      allowed,
      "cors.ts no longer states access-control-allow-headers as one literal",
    ).not.toBe(null);
    expect(allowed?.[1]).toBe(playgroundSendableHeaders.join(", "));
    expect(playgroundSendableHeaders).toContain("x-llmingress-route-tag");
  });
});

describe("what the Playground does with the built headers", () => {
  it("cannot let a picked header overwrite the three the form owns", () => {
    const playground = read("apps/console/src/app/_ui/playground/playground.tsx");
    const spreadAt = playground.indexOf("...builtHeaders.headers,");
    const authorizationAt = playground.indexOf(
      ["authorization: `Bearer ", "$", "{apiKey.trim()}`"].join(""),
    );
    const requestIdAt = playground.indexOf(
      ['"x-request-id": `playground_', "$", "{crypto.randomUUID()}`"].join(""),
    );

    expect(spreadAt).toBeGreaterThan(-1);
    // The rows are spread first and the form's own values last, so whatever a
    // row carries, authentication, body shape and the id used to find this
    // request's trace stay the form's.
    expect(authorizationAt).toBeGreaterThan(spreadAt);
    expect(playground.indexOf('"content-type": "application/json"')).toBeGreaterThan(spreadAt);
    expect(requestIdAt).toBeGreaterThan(spreadAt);
  });

  it("does not send a request whose rows it has already refused", () => {
    const playground = read("apps/console/src/app/_ui/playground/playground.tsx");
    expect(playground).toContain("builtHeaders.issues.length > 0");
  });

  it("asks which models the key may call with nothing but the key", () => {
    const playground = read("apps/console/src/app/_ui/playground/playground.tsx");
    expect(playground).toContain(
      ["headers: { authorization: `Bearer ", "$", "{secret}` },"].join(""),
    );
  });

  it("keeps the picked headers out of the URL", () => {
    // /playground remembers no query at all: a header row is request input, not
    // a view choice, and restoring one would send it again unasked.
    expect(read("apps/console/src/app/_ui/nav-state.ts")).toContain('"/playground": [],');
    expect(read("apps/console/src/app/_ui/playground/playground.tsx")).toContain(
      "const [headerRows, setHeaderRows] = useState<PlaygroundHeaderRow[]>([]);",
    );
  });
});
