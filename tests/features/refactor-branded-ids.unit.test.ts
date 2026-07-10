import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  asProviderId,
  type RouteCandidate,
  type RoutePolicy,
  selectRouteAttempts,
} from "../../packages/domain/src/index.ts";

function candidate(): RouteCandidate {
  return {
    candidateOrder: 1,
    displayName: "m",
    modelId: "m",
    price: {
      modelId: "m",
      priceVersion: "test",
      providerKey: "openai",
      reason: "no_current_price",
      status: "unknown_price",
    },
    providerId: "provider-1",
    providerKey: "openai",
    providerModelId: "pm-1",
    supportsTools: true,
  };
}

describe("refactor-branded-ids", () => {
  it("exports the Brand utility and branded id types", () => {
    const domain = readFileSync("packages/domain/src/index.ts", "utf8");
    expect(domain).toContain("export type Brand<");
    expect(domain).toContain('export type RoutePolicyId = Brand<string, "RoutePolicyId">;');
    expect(domain).toContain('export type VirtualModelId = Brand<string, "VirtualModelId">;');
    expect(domain).toContain('export type ProviderId = Brand<string, "ProviderId">;');
    expect(domain).toContain('export type ProviderModelId = Brand<string, "ProviderModelId">;');
    expect(domain).toContain("routePolicyId: RoutePolicyId;");
  });

  it("keeps branded ids runtime-identical to their strings", () => {
    expect(asProviderId("provider-1")).toBe("provider-1");
    const policy: RoutePolicy = {
      candidates: [candidate()],
      id: "rp-1",
      strategy: "fixed",
      virtualModelId: "vm-1",
      virtualModelName: "vm",
    };
    const result = selectRouteAttempts({
      estimatedInputTokens: 1,
      estimatedOutputTokens: 1,
      snapshot: { routePolicies: [policy] },
      virtualModelName: "vm",
    });
    expect(result.decision?.routePolicyId).toBe("rp-1");
    expect(result.decision?.virtualModelId).toBe("vm-1");
    expect(result.decision?.providerId).toBe("provider-1");
    expect(result.decision?.providerModelId).toBe("pm-1");
  });
});
