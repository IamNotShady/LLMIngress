import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("Console core workflow", () => {
  it("presents the four-step setup flow on Overview", () => {
    const setup = read("apps/console/src/app/_ui/overview/getting-started.tsx");
    expect(setup).toContain("1 · Connect a provider");
    expect(setup).toContain("2 · Create a virtual model");
    expect(setup).toContain("3 · Issue an API key");
    expect(setup).toContain("4 · Set limits, then verify");
    for (const href of ["/providers", "/models", "/api-keys", "/playground"]) {
      expect(setup, href).toContain(`href: "${href}"`);
    }
    // The limits step opens the keys it is about: the ones with no rules while
    // any exist, and the whole list once they all have some.
    expect(setup).toContain('counts.unlimitedKeyCount > 0 ? "/limits?state=off" : "/limits"');
  });

  it("derives each step from the tables rather than storing progress", () => {
    const setup = read("apps/console/src/app/_ui/overview/getting-started.tsx");
    expect(setup).toContain("done: counts.providerCount > 0");
    expect(setup).toContain("done: counts.virtualModelCount > 0");
    // Issuing a key is not enough for step four; the key has to have rules.
    expect(setup).toContain("counts.apiKeyCount > 0 && counts.unlimitedKeyCount === 0");
  });

  it("does not imply Gateway readiness when only its target URL is known", () => {
    const masthead = read("apps/console/src/app/_ui/masthead.tsx");
    expect(masthead).toContain("gw · {gatewayAddress}");
    expect(masthead).not.toMatch(/gateway (healthy|ok|online)/i);
  });

  it("gives every blocked empty state a path into the core setup flow", () => {
    const apiKeys = read("apps/console/src/app/(dashboard)/api-keys/page.tsx");
    const limits = read("apps/console/src/app/(dashboard)/limits/page.tsx");
    const virtualModels = read("apps/console/src/app/(dashboard)/models/page.tsx");

    expect(apiKeys).toContain("+ New API Key");
    expect(limits).toContain("Issue a key first");
    expect(virtualModels).toContain("Connect a provider first");
    // A route with no candidate cannot be saved.
    const editor = read("apps/console/src/app/_ui/virtual-models/dialogs.tsx");
    expect(editor).toContain("disabled={orderedSelection.length === 0}");
  });
});
