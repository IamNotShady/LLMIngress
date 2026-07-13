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
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}): RouteCandidate {
  const modelId = `model-${input.candidateOrder}`;
  return {
    candidateOrder: input.candidateOrder,
    displayName: modelId,
    modelId,
    price: {
      currency: "USD",
      inputUsdPerMillionTokens: input.inputUsdPerMillionTokens,
      modelId,
      outputUsdPerMillionTokens: input.outputUsdPerMillionTokens,
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

function unknownPriceCandidate(candidateOrder: number): RouteCandidate {
  const modelId = `model-${candidateOrder}`;
  return {
    candidateOrder,
    displayName: modelId,
    modelId,
    price: {
      modelId,
      priceVersion: "test",
      providerKey: "openai",
      reason: "no_current_price",
      status: "unknown_price",
    },
    providerId: "provider-1",
    providerKey: "openai",
    providerModelId: `pm-${candidateOrder}`,
  };
}

function policyWith(strategy: RoutePolicy["strategy"]): RoutePolicy {
  return {
    candidates: [
      pricedCandidate({
        candidateOrder: 1,
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 10,
      }),
      pricedCandidate({
        candidateOrder: 2,
        inputUsdPerMillionTokens: 6,
        outputUsdPerMillionTokens: 6,
      }),
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

  it("orders cost_first by input plus output price without token weighting", () => {
    const result = select("cost_first");
    expect(result.chain.map((c) => c.candidateOrder)).toEqual([1, 2]);
    expect(result.decision?.routeReason.message).toBe(
      "cost_first route for vm selected cheapest eligible candidate 1.",
    );
    expect(result.decision?.routeReason.estimatedCostUsd).toBeUndefined();
    expect(result.decision?.routeReason.priceSource).toBe("manual_override");

    const outputHeavy = selectRouteAttempts({
      estimatedInputTokens: 1,
      estimatedOutputTokens: 1_000_000,
      snapshot: { routePolicies: [policyWith("cost_first")] },
      virtualModelName: "vm",
    });
    expect(outputHeavy.chain.map((candidate) => candidate.candidateOrder)).toEqual([1, 2]);
  });

  it("appends unknown prices in configured order after priced candidates", () => {
    const routePolicy = policyWith("cost_first");
    routePolicy.candidates = [
      unknownPriceCandidate(1),
      pricedCandidate({
        candidateOrder: 2,
        inputUsdPerMillionTokens: 2,
        outputUsdPerMillionTokens: 2,
      }),
      unknownPriceCandidate(3),
      pricedCandidate({
        candidateOrder: 4,
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 1,
      }),
    ];

    const result = selectRouteAttempts({
      estimatedInputTokens: 1_000,
      estimatedOutputTokens: 1_000,
      snapshot: { routePolicies: [routePolicy] },
      virtualModelName: "vm",
    });

    expect(result.chain.map((candidate) => candidate.candidateOrder)).toEqual([4, 2, 1, 3]);
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
