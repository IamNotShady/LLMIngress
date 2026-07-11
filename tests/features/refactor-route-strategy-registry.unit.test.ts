import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildRouteAttemptCandidates,
  type RouteCandidate,
  type RoutePolicy,
  selectRouteAttempts,
} from "../../packages/domain/src/index.ts";

function pricedCandidate(input: {
  candidateOrder: number;
  usdPerMillionTokens: number;
}): RouteCandidate {
  const modelId = `model-${input.candidateOrder}`;
  return {
    candidateOrder: input.candidateOrder,
    displayName: modelId,
    modelId,
    price: {
      currency: "USD",
      inputUsdPerMillionTokens: input.usdPerMillionTokens,
      modelId,
      outputUsdPerMillionTokens: input.usdPerMillionTokens,
      priceVersion: "test",
      providerKey: "openai",
      snapshotDate: "2026-01-01",
      source: "manual_override",
      sourceUrl: "https://example.com",
      status: "priced",
      unit: "per_1m_tokens",
    },
    providerId: "provider-1",
    providerKey: "openai",
    providerModelId: `pm-${input.candidateOrder}`,
  };
}

function policyWith(strategy: RoutePolicy["strategy"]): RoutePolicy {
  return {
    candidates: [
      pricedCandidate({ candidateOrder: 1, usdPerMillionTokens: 1 }),
      pricedCandidate({ candidateOrder: 2, usdPerMillionTokens: 10 }),
    ],
    id: "rp-1",
    strategy,
    virtualModelId: "vm-1",
    virtualModelName: "vm",
  };
}

function select(strategy: RoutePolicy["strategy"]) {
  return selectRouteAttempts({
    estimatedInputTokens: 1_000,
    estimatedOutputTokens: 1_000,
    random: () => 0,
    snapshot: { routePolicies: [policyWith(strategy)] },
    virtualModelName: "vm",
  });
}

describe("refactor-route-strategy-registry", () => {
  it("dispatches strategies through a registry, not if-chains", () => {
    const source = readFileSync("packages/domain/src/index.ts", "utf8");
    expect(source).toContain("routeStrategyHandlers");
    expect(source).toContain("Record<RoutePolicyStrategy");
    expect(source.match(/strategy === "/g) ?? []).toEqual([]);
  });

  it("keeps fixed strategy behavior: candidateOrder ascending", () => {
    const result = select("fixed");
    expect(result.chain.map((c) => c.candidateOrder)).toEqual([1, 2]);
    expect(result.decision?.routeReason.message).toBe(
      "fixed route for vm selected configured candidate 1.",
    );
  });

  it("keeps cost_first behavior: cheapest first with estimated cost", () => {
    const result = select("cost_first");
    expect(result.chain.map((c) => c.candidateOrder)).toEqual([1, 2]);
    expect(result.decision?.routeReason.message).toBe(
      "cost_first route for vm selected cheapest eligible candidate 1.",
    );
    expect(result.decision?.routeReason.estimatedCostUsd).toBeGreaterThan(0);
    expect(result.decision?.routeReason.priceSource).toBe("manual_override");
  });

  it("keeps random behavior deterministic under injected random", () => {
    // random: () => 0 时 Fisher-Yates 在两候选上必定交换 → [2, 1]
    const result = select("random");
    expect(result.chain.map((c) => c.candidateOrder)).toEqual([2, 1]);
    expect(result.decision?.routeReason.message).toBe(
      "random route for vm selected eligible candidate 2.",
    );
  });

  it("orders attempt candidates through the same registry", () => {
    const chain = buildRouteAttemptCandidates({
      estimatedInputTokens: 1_000,
      estimatedOutputTokens: 1_000,
      routePolicy: policyWith("cost_first"),
    });
    expect(chain.map((c) => c.candidateOrder)).toEqual([1, 2]);
  });
});
