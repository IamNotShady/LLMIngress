import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentLimitTypes } from "../../packages/domain/src/index.ts";

describe("refactor-agent-limit-domain-types", () => {
  it("owns agent limit vocabulary in packages/domain", () => {
    const domain = readFileSync("packages/domain/src/index.ts", "utf8");
    expect(domain).toContain("export const agentLimitTypes");
    expect(domain).toContain("export const agentLimitEnforcementPolicies");
    expect(domain).toContain("export const agentLimitPeriods");
    expect(domain).toContain("export const agentLimitUnits");
    expect([...agentLimitTypes]).toEqual(["budget", "concurrency", "rpm", "token", "tpm"]);
  });

  it("redeclares no string unions in console or gateway modules", () => {
    const consoleSource = readFileSync("packages/db/src/console-agent-limits.ts", "utf8");
    const gatewaySource = readFileSync(
      "packages/gateway-runtime/src/gateway-agent-limits.ts",
      "utf8",
    );
    expect(consoleSource).not.toMatch(/export type AgentLimitType =\s*"/);
    expect(consoleSource).not.toMatch(/export type AgentLimitEnforcementPolicy =\s*"/);
    expect(consoleSource).not.toMatch(/export type AgentLimitPeriod =\s*"/);
    expect(consoleSource).not.toMatch(/export type AgentLimitUnit =\s*"/);
    expect(gatewaySource).not.toMatch(/export type GatewayAgentLimitType =\s*"/);
    expect(gatewaySource).not.toMatch(/export type GatewayAgentLimitEnforcementPolicy =\s*"/);
  });
});
