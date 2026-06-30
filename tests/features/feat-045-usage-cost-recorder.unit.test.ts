import { describe, expect, it } from "vitest";
import { buildGatewayUsageCostRecords } from "../../packages/db/src/gateway-usage-recorder";

describe("feat-045 usage cost baseline and savings recorder", () => {
  it("builds estimated usage actual cost baseline cost and savings", () => {
    expect(
      buildGatewayUsageCostRecords({
        actualPrice: pricedModel("gpt-4.1-nano", 0.1, 0.4),
        baselinePrice: pricedModel("gpt-4.1", 2, 8),
        baselineProviderModelId: "baseline-model",
        estimatedInputTokens: 1_000,
        estimatedOutputTokens: 500,
        providerModelId: "actual-model",
      }),
    ).toEqual({
      requestCost: {
        costSource: "estimated",
        inputCostUsd: 0.0001,
        outputCostUsd: 0.0002,
        priceSource: "built_in_static_snapshot",
        priceVersion: "mvp-static-2026-06-13",
        totalCostUsd: 0.0003,
      },
      requestSavings: {
        actualCostUsd: 0.0003,
        baselineCostUsd: 0.006,
        baselineProviderModelId: "baseline-model",
        priceSource: "built_in_static_snapshot",
        priceVersion: "mvp-static-2026-06-13",
        savingsPercent: 95,
        savingsUsd: 0.0057,
      },
      requestUsage: {
        cachedInputTokens: 0,
        inputTokens: 1_000,
        outputTokens: 500,
        reasoningTokens: 0,
        tokenSource: "estimated",
        totalTokens: 1_500,
      },
    });
  });

  it("marks unknown-price costs and savings as unavailable while preserving token usage", () => {
    expect(
      buildGatewayUsageCostRecords({
        actualPrice: {
          modelId: "unknown-model",
          priceVersion: "mvp-static-2026-06-13",
          providerKey: "unknown-provider",
          reason: "model_not_in_builtin_registry",
          status: "unknown_price",
        },
        baselinePrice: pricedModel("gpt-4.1", 2, 8),
        baselineProviderModelId: "baseline-model",
        estimatedInputTokens: 10,
        estimatedOutputTokens: 20,
        providerModelId: "unknown-model-id",
      }),
    ).toMatchObject({
      requestCost: {
        costSource: "unavailable",
        inputCostUsd: null,
        outputCostUsd: null,
        totalCostUsd: null,
      },
      requestSavings: {
        actualCostUsd: null,
        baselineCostUsd: null,
        savingsPercent: null,
        savingsUsd: null,
      },
      requestUsage: {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      },
    });
  });

  it("keeps actual request cost when only baseline price is unknown", () => {
    expect(
      buildGatewayUsageCostRecords({
        actualPrice: pricedModel("gpt-4.1-nano", 0.1, 0.4),
        baselinePrice: {
          modelId: "unknown-baseline",
          priceVersion: "mvp-static-2026-06-13",
          providerKey: "unknown-provider",
          reason: "model_not_in_builtin_registry",
          status: "unknown_price",
        },
        baselineProviderModelId: "unknown-baseline-model",
        estimatedInputTokens: 100,
        estimatedOutputTokens: 200,
        providerModelId: "actual-model",
      }),
    ).toMatchObject({
      requestCost: {
        costSource: "estimated",
        inputCostUsd: 0.00001,
        outputCostUsd: 0.00008,
        totalCostUsd: 0.00009,
      },
      requestSavings: {
        actualCostUsd: 0.00009,
        baselineCostUsd: null,
        baselineProviderModelId: "unknown-baseline-model",
        savingsPercent: null,
        savingsUsd: null,
      },
      requestUsage: {
        cachedInputTokens: 0,
        inputTokens: 100,
        outputTokens: 200,
        reasoningTokens: 0,
        totalTokens: 300,
      },
    });
  });
});

function pricedModel(modelId: string, inputPrice: number, outputPrice: number) {
  return {
    currency: "USD" as const,
    inputUsdPerMillionTokens: inputPrice,
    modelId,
    outputUsdPerMillionTokens: outputPrice,
    priceVersion: "mvp-static-2026-06-13",
    providerKey: "openai",
    snapshotDate: "2026-06-13" as const,
    source: "built_in_static_snapshot" as const,
    sourceUrl: "https://example.test/pricing",
    status: "priced" as const,
    unit: "per_1m_tokens" as const,
  };
}
