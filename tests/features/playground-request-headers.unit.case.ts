import { readFileSync } from "node:fs";
import { readConsoleActivityRouteTag } from "@llmingress/db/console-activity";
import { describe, expect, it } from "vitest";
import {
  describePlaygroundRouteTag,
  formatPlaygroundHeaderIssue,
  parsePlaygroundHeaders,
  playgroundSendableHeaders,
} from "../../apps/console/src/app/_ui/playground/helpers.ts";

const read = (path: string) => readFileSync(path, "utf8");

describe("the headers a Playground request may carry", () => {
  it("reads one header per line, with the name normalized and the value left alone", () => {
    expect(parsePlaygroundHeaders("x-llmingress-route-tag: fast")).toEqual({
      headers: { "x-llmingress-route-tag": "fast" },
      issues: [],
    });

    // Blank lines are spacing, not headers; a name is matched case-insensitively
    // because header names are; a value keeps its own case and its own colons,
    // because only the first one separates.
    expect(
      parsePlaygroundHeaders(
        ["X-LLMIngress-Route-Tag:  Fast ", "", "   ", "x-request-id: req:1:2"].join("\n"),
      ),
    ).toEqual({
      headers: { "x-llmingress-route-tag": "Fast", "x-request-id": "req:1:2" },
      issues: [],
    });
  });

  it("lets a later line replace the same header written earlier", () => {
    expect(
      parsePlaygroundHeaders(["x-request-id: first", "X-Request-Id: second"].join("\r\n")).headers,
    ).toEqual({ "x-request-id": "second" });
  });

  it("refuses a line that is not a header, naming the line it was on", () => {
    const text = [
      "x-llmingress-route-tag fast",
      ": fast",
      "route tag: fast",
      "x-request-id:   ",
      "x-request-id: 值",
    ].join("\n");
    const parsed = parsePlaygroundHeaders(text);

    expect(parsed.headers).toEqual({});
    expect(parsed.issues.map((issue) => issue.line)).toEqual([1, 2, 3, 4, 5]);
    for (const issue of parsed.issues) {
      expect(issue.reason, `line ${issue.line}`).toBe("malformed");
    }
  });

  it("sends neither of the two headers the form already owns", () => {
    // Both are in the allowlist, so the allowlist cannot be what stops them:
    // they are refused because the API KEY field and the fixed JSON content
    // type are where they come from, and a second copy would fight them.
    const parsed = parsePlaygroundHeaders(
      ["Authorization: Bearer llmi_other", "CONTENT-TYPE: text/plain"].join("\n"),
    );

    expect(parsed.headers).toEqual({});
    expect(parsed.issues).toEqual([
      { line: 1, name: "authorization", reason: "reserved" },
      { line: 2, name: "content-type", reason: "reserved" },
    ]);
  });

  it("refuses a header the gateway's CORS allowlist does not name", () => {
    // The browser would refuse it at the preflight, and the request would come
    // back as an unexplained network failure. Saying so here is the difference
    // between a typo and a bug hunt.
    expect(parsePlaygroundHeaders("x-custom: 1")).toEqual({
      headers: {},
      issues: [{ line: 1, name: "x-custom", reason: "not_allowed" }],
    });
  });

  it("has nothing to send and nothing to complain about when the field is empty", () => {
    expect(parsePlaygroundHeaders("")).toEqual({ headers: {}, issues: [] });
    expect(parsePlaygroundHeaders("\n \n")).toEqual({ headers: {}, issues: [] });
  });
});

describe("what a refused header line says", () => {
  it("tells the operator what to change, per reason", () => {
    expect(formatPlaygroundHeaderIssue({ line: 3, name: "", reason: "malformed" })).toBe(
      "line 3: use name: value",
    );
    expect(
      formatPlaygroundHeaderIssue({ line: 1, name: "authorization", reason: "reserved" }),
    ).toBe("line 1: authorization is sent from the API KEY field");
    expect(formatPlaygroundHeaderIssue({ line: 2, name: "content-type", reason: "reserved" })).toBe(
      "line 2: content-type is fixed at application/json",
    );
    expect(formatPlaygroundHeaderIssue({ line: 4, name: "x-custom", reason: "not_allowed" })).toBe(
      "line 4: x-custom is not in the gateway CORS allowlist — the browser refuses it before it is sent",
    );
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

describe("what the Playground does with the parsed headers", () => {
  it("cannot let a typed header overwrite the two the form owns", () => {
    const playground = read("apps/console/src/app/_ui/playground/playground.tsx");
    const spreadAt = playground.indexOf("...parsedHeaders.headers,");
    const authorizationAt = playground.indexOf(
      ["authorization: `Bearer ", "$", "{apiKey.trim()}`"].join(""),
    );

    expect(spreadAt).toBeGreaterThan(-1);
    // Second guard behind the reserved rule: even if a reserved line reached
    // this object, the form's own values are spread last and win.
    expect(authorizationAt).toBeGreaterThan(spreadAt);
    expect(playground.indexOf('"content-type": "application/json"')).toBeGreaterThan(spreadAt);
  });

  it("does not send a request it already knows the browser will refuse", () => {
    const playground = read("apps/console/src/app/_ui/playground/playground.tsx");
    expect(playground).toContain("parsedHeaders.issues.length > 0");
  });

  it("asks which models the key may call with nothing but the key", () => {
    const playground = read("apps/console/src/app/_ui/playground/playground.tsx");
    expect(playground).toContain(
      ["headers: { authorization: `Bearer ", "$", "{secret}` },"].join(""),
    );
  });

  it("keeps the typed headers out of the URL", () => {
    // /playground remembers no query at all: a header line is request input,
    // not a view choice, and restoring one would send it again unasked.
    expect(read("apps/console/src/app/_ui/nav-state.ts")).toContain('"/playground": [],');
    expect(read("apps/console/src/app/_ui/playground/playground.tsx")).toContain(
      'const [headersText, setHeadersText] = useState("");',
    );
  });
});
