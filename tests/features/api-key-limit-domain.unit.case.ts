import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { apiKeyLimitTypes } from "../../packages/domain/src/index.ts";

describe("apiKey limit domain types", () => {
  it("owns apiKey limit vocabulary in packages/domain", () => {
    const domain = readFileSync("packages/domain/src/index.ts", "utf8");
    expect(domain).toContain("export const apiKeyLimitTypes");
    expect(domain).toContain("export const apiKeyLimitEnforcementPolicies");
    expect(domain).toContain("export const apiKeyLimitPeriods");
    expect(domain).toContain("export const apiKeyLimitUnits");
    expect([...apiKeyLimitTypes]).toEqual(["budget", "concurrency", "rpm", "token", "tpm"]);
  });

  it("redeclares no string unions in console or gateway modules", () => {
    const consoleSource = readFileSync("packages/db/src/console-api-key-limits.ts", "utf8");
    const gatewaySource = readFileSync(
      "packages/gateway-runtime/src/gateway-api-key-limits.ts",
      "utf8",
    );
    expect(consoleSource).not.toMatch(/export type ApiKeyLimitType =\s*"/);
    expect(consoleSource).not.toMatch(/export type ApiKeyLimitEnforcementPolicy =\s*"/);
    expect(consoleSource).not.toMatch(/export type ApiKeyLimitPeriod =\s*"/);
    expect(consoleSource).not.toMatch(/export type ApiKeyLimitUnit =\s*"/);
    expect(gatewaySource).not.toMatch(/export type GatewayApiKeyLimitType =\s*"/);
    expect(gatewaySource).not.toMatch(/export type GatewayApiKeyLimitEnforcementPolicy =\s*"/);
  });
});
