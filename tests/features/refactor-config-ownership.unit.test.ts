import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gatewayPublicBaseUrl } from "../../packages/config/src/index.ts";

const formerInlineDefaultFiles = [
  "apps/console/src/app/_modules/runtime-section.tsx",
  "apps/console/src/app/api/agents/_created-page.ts",
  "apps/console/src/app/(dashboard)/playground/page.tsx",
  "apps/console/src/app/(dashboard)/layout.tsx",
];

describe("refactor-config-ownership", () => {
  it("resolves the gateway public base url through packages/config", () => {
    expect(gatewayPublicBaseUrl({ GATEWAY_PUBLIC_BASE_URL: " http://gw.example:9000 " })).toBe(
      "http://gw.example:9000",
    );
    expect(gatewayPublicBaseUrl({})).toBe("http://127.0.0.1:4000");
  });

  it("inlines no GATEWAY_PUBLIC_BASE_URL default in console files", () => {
    for (const file of formerInlineDefaultFiles) {
      expect(readFileSync(file, "utf8")).not.toContain("process.env.GATEWAY_PUBLIC_BASE_URL");
    }
  });

  it("defines BootstrapConfigFile once, in packages/config", () => {
    expect(readFileSync("packages/config/src/index.ts", "utf8")).toContain(
      "export type BootstrapConfigFile",
    );
    const client = readFileSync("packages/db/src/client.ts", "utf8");
    expect(client).not.toContain("type BootstrapConfigFile");
    expect(client).not.toContain("function readBootstrapConfigFile");
  });
});
