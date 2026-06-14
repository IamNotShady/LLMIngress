import { describe, expect, it } from "vitest";
import type { GatewayConfigSnapshot } from "../../apps/gateway/src/config-reload";
import { selectRouteCandidate } from "../../apps/gateway/src/route-engine";

describe("feat-032 deterministic route engine", () => {
  it("selects the fixed target deterministically with a route reason", () => {
    const snapshot = createSnapshot({
      strategy: "fixed",
      candidates: [
        createCandidate({
          candidateOrder: 1,
          modelId: "gpt-4.1",
          providerModelId: "fixed-expensive-model",
          price: pricedModel("gpt-4.1", 2, 8),
        }),
        createCandidate({
          candidateOrder: 2,
          modelId: "gpt-4.1-nano",
          providerModelId: "cheaper-model",
          price: pricedModel("gpt-4.1-nano", 0.1, 0.4),
        }),
      ],
    });

    const firstDecision = selectRouteCandidate({
      estimatedInputTokens: 1_000_000,
      estimatedOutputTokens: 1_000_000,
      snapshot,
      virtualModelName: "coding",
    });
    const secondDecision = selectRouteCandidate({
      estimatedInputTokens: 1_000_000,
      estimatedOutputTokens: 1_000_000,
      snapshot,
      virtualModelName: "coding",
    });

    expect(firstDecision).toEqual(secondDecision);
    expect(firstDecision).toMatchObject({
      modelId: "gpt-4.1",
      providerModelId: "fixed-expensive-model",
      routeReason: {
        selectedCandidateOrder: 1,
        strategy: "fixed",
      },
    });
    expect(firstDecision.routeReason.message).toContain("fixed route");
  });

  it("selects the cheapest priced primary candidate deterministically", () => {
    const snapshot = createSnapshot({
      strategy: "cost_first",
      candidates: [
        createCandidate({
          candidateOrder: 1,
          modelId: "gpt-4.1",
          providerModelId: "expensive-model",
          price: pricedModel("gpt-4.1", 2, 8),
        }),
        createCandidate({
          candidateOrder: 2,
          modelId: "custom-unpriced",
          providerModelId: "unknown-price-model",
          price: {
            modelId: "custom-unpriced",
            priceVersion: "mvp-static-2026-06-13",
            providerKey: "openai",
            reason: "model_not_in_builtin_registry",
            status: "unknown_price",
          },
        }),
        createCandidate({
          candidateOrder: 3,
          modelId: "gpt-4.1-nano",
          providerModelId: "cheap-model",
          price: pricedModel("gpt-4.1-nano", 0.1, 0.4),
        }),
      ],
    });

    const decision = selectRouteCandidate({
      estimatedInputTokens: 1_000_000,
      estimatedOutputTokens: 1_000_000,
      snapshot,
      virtualModelName: "coding",
    });

    expect(decision).toMatchObject({
      modelId: "gpt-4.1-nano",
      providerModelId: "cheap-model",
      routeReason: {
        estimatedCostUsd: 0.5,
        selectedCandidateOrder: 3,
        strategy: "cost_first",
      },
    });
    expect(decision.routeReason.message).toContain("cheapest eligible candidate");
  });
});

type RoutePolicyInput = GatewayConfigSnapshot["routePolicies"][number];
type RouteCandidateInput = RoutePolicyInput["candidates"][number];

function createSnapshot(input: {
  candidates: RouteCandidateInput[];
  strategy: RoutePolicyInput["strategy"];
}): GatewayConfigSnapshot {
  return {
    loadedAt: new Date("2026-06-14T00:00:00.000Z"),
    providers: [],
    routePolicies: [
      {
        candidates: input.candidates,
        id: "route-policy",
        strategy: input.strategy,
        virtualModelId: "virtual-model",
        virtualModelName: "coding",
      },
    ],
    version: 1,
  };
}

function createCandidate(input: {
  candidateOrder: number;
  modelId: string;
  price: RouteCandidateInput["price"];
  providerModelId: string;
}): RouteCandidateInput {
  return {
    candidateOrder: input.candidateOrder,
    displayName: input.modelId,
    isFallback: false,
    modelId: input.modelId,
    price: input.price,
    providerId: "provider",
    providerKey: "openai",
    providerModelId: input.providerModelId,
  };
}

function pricedModel(
  modelId: string,
  inputPrice: number,
  outputPrice: number,
): RouteCandidateInput["price"] {
  return {
    currency: "USD",
    inputUsdPerMillionTokens: inputPrice,
    modelId,
    outputUsdPerMillionTokens: outputPrice,
    priceVersion: "mvp-static-2026-06-13",
    providerKey: "openai",
    snapshotDate: "2026-06-13",
    source: "built_in_static_snapshot",
    sourceUrl: "https://example.test/pricing",
    status: "priced",
    unit: "per_1m_tokens",
  };
}
