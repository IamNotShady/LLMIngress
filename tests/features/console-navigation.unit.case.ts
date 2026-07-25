import { describe, expect, test } from "vitest";
import {
  type ConsoleNavItem,
  consoleNavItems,
  findActiveNavItem,
} from "../../apps/console/src/app/_ui/nav";
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

  test("every item has an absolute href, a label, and a hint", () => {
    for (const item of consoleNavItems) {
      expect(item.href.startsWith("/")).toBe(true);
      expect(item.label.trim().length).toBeGreaterThan(0);
      expect(item.hint.trim().length).toBeGreaterThan(0);
    }
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
});
