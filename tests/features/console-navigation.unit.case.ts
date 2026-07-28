import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  type ConsoleNavItem,
  consoleNavItems,
  findActiveNavItem,
} from "../../apps/console/src/app/_ui/nav";
import {
  MODULE_STATE_STORAGE_KEY,
  rememberedModuleHref,
  rememberedModuleQuery,
} from "../../apps/console/src/app/_ui/nav-state";
import { redirectToConsolePath } from "../../apps/console/src/app/api/_redirect";

const expectedRoutes = [
  "/",
  "/api-keys",
  "/providers",
  "/models",
  "/activity",
  "/usage",
  "/limits",
  "/playground",
];

describe("console module navigation config", () => {
  test("flattened items cover exactly the expected module routes", () => {
    const hrefs = consoleNavItems.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length); // unique
    expect(hrefs.sort()).toEqual([...expectedRoutes].sort());
  });

  test("every item has an absolute href and a label", () => {
    // The masthead is a single row of labels — there is no second line to hint
    // in, so a hint would have nowhere to render.
    for (const item of consoleNavItems) {
      expect(item.href.startsWith("/")).toBe(true);
      expect(item.label.trim().length).toBeGreaterThan(0);
    }
  });

  test("items are ordered by responsibility, not alphabetically", () => {
    expect(consoleNavItems.map((item) => item.label)).toEqual([
      "Overview",
      "Providers",
      "Virtual Models",
      "API Keys",
      "Limits",
      "Activity",
      "Usage",
      "Playground",
    ]);
  });

  test("findActiveNavItem resolves the longest matching href", () => {
    expect(findActiveNavItem("/")?.href).toBe("/");
    expect(findActiveNavItem("/api-keys")?.href).toBe("/api-keys");
    expect(findActiveNavItem("/providers?modelRefreshProviderId=abc")?.href).toBe("/providers");
    // A deeper path under a module still resolves to that module, not Overview.
    expect(findActiveNavItem("/limits/anything")?.href).toBe("/limits");
  });

  test("overview lives at the root so first-run login lands somewhere real", () => {
    const overview = consoleNavItems.find((item: ConsoleNavItem) => item.href === "/");
    expect(overview?.label).toBe("Overview");
  });

  test("api redirects stay relative behind Docker port mappings", () => {
    const internalUrl = new URL("/providers?selected=abc#keys", "http://0.0.0.0:3000");
    expect(redirectToConsolePath(internalUrl).headers.get("location")).toBe(
      "/providers?selected=abc#keys",
    );
    expect(redirectToConsolePath("/").headers.get("location")).toBe("/");
  });

  test("module navigation remembers durable view choices on every URL-driven page", () => {
    expect(rememberedModuleHref("/", "window=7d&setup=closed")).toBe(
      "/?window=7d&setup=closed",
    );
    expect(rememberedModuleHref("/usage", "window=30d")).toBe("/usage?window=30d");
    expect(
      rememberedModuleHref(
        "/activity",
        "status=failed&protocol=messages&apiKey=key-1&virtualModel=vm-1&provider=p-1&window=7d&q=gw&page=3",
      ),
    ).toBe(
      "/activity?status=failed&protocol=messages&apiKey=key-1&virtualModel=vm-1&provider=p-1&window=7d&q=gw&page=3",
    );
    expect(
      rememberedModuleHref("/providers", "selected=p-1&availability=all&modelQuery=gpt"),
    ).toBe("/providers?selected=p-1&availability=all&modelQuery=gpt");
    expect(rememberedModuleHref("/models", "selected=vm-1&strategy=fixed")).toBe(
      "/models?selected=vm-1&strategy=fixed",
    );
    expect(rememberedModuleHref("/api-keys", "selected=key-1&q=agent")).toBe(
      "/api-keys?selected=key-1&q=agent",
    );
    expect(rememberedModuleHref("/limits", "q=agent&state=off")).toBe(
      "/limits?q=agent&state=off",
    );
  });

  test("module navigation drops transient, unsafe and unrelated state", () => {
    expect(
      rememberedModuleQuery(
        "/providers",
        "selected=p-1&dialog=edit&connection=c-1&providerOAuthUserCode=SECRET&toast=done",
      ),
    ).toBe("selected=p-1");
    expect(rememberedModuleQuery("/activity", "status=failed&request=gw-1")).toBe(
      "status=failed",
    );
    expect(rememberedModuleQuery("/limits", "state=off&selected=key-1")).toBe("state=off");
    expect(rememberedModuleQuery("/playground", "apiKey=llmi_secret&model=private")).toBe("");
  });

  test("the masthead stores and restores sanitized module queries", () => {
    expect(MODULE_STATE_STORAGE_KEY).toContain("console-module-state");
    const masthead = readFileSync("apps/console/src/app/_ui/masthead.tsx", "utf8");
    expect(masthead).toContain("readRememberedQueries()");
    expect(masthead).toContain("window.localStorage.setItem(MODULE_STATE_STORAGE_KEY");
    expect(masthead).toContain("rememberedModuleHref(item.href, rememberedQuery)");
  });
});
