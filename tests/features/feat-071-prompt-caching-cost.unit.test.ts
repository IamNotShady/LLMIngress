import { describe, expect, it } from "vitest";
import {
  buildGatewayUsageCostRecords,
  readGatewayProviderTokenUsage,
} from "../../packages/db/src/gateway-usage-recorder";

describe("feat-071 prompt caching cost accounting", () => {
  it("uses provider usage cached input tokens and cached-input pricing for actual and baseline cost", () => {
    expect(
      buildGatewayUsageCostRecords({
        actualPrice: pricedModel("gpt-4.1-nano", 0.1, 0.025, 0.4),
        baselinePrice: pricedModel("gpt-4.1", 2, 0.5, 8),
        baselineProviderModelId: "baseline-model",
        estimatedInputTokens: 10,
        estimatedOutputTokens: 20,
        providerModelId: "actual-model",
        providerUsage: {
          cachedInputTokens: 400,
          inputTokens: 1_000,
          outputTokens: 200,
          reasoningTokens: 25,
        },
      }),
    ).toEqual({
      requestCost: {
        costSource: "estimated",
        inputCostUsd: 0.00007,
        outputCostUsd: 0.00008,
        priceSource: "built_in_static_snapshot",
        priceVersion: "mvp-static-2026-06-13",
        totalCostUsd: 0.00015,
      },
      requestSavings: {
        actualCostUsd: 0.00015,
        baselineCostUsd: 0.003,
        baselineProviderModelId: "baseline-model",
        priceSource: "built_in_static_snapshot",
        priceVersion: "mvp-static-2026-06-13",
        savingsPercent: 95,
        savingsUsd: 0.00285,
      },
      requestUsage: {
        cachedInputTokens: 400,
        inputTokens: 1_000,
        outputTokens: 200,
        reasoningTokens: 25,
        tokenSource: "provider",
        totalTokens: 1_200,
      },
    });
  });

  it("charges cached input tokens at normal input price when cached-input pricing is unavailable", () => {
    expect(
      buildGatewayUsageCostRecords({
        actualPrice: pricedModel("manual-model", 2, null, 8),
        baselinePrice: pricedModel("baseline-model", 2, null, 8),
        baselineProviderModelId: "baseline-model",
        estimatedInputTokens: 1,
        estimatedOutputTokens: 1,
        providerModelId: "manual-model",
        providerUsage: {
          cachedInputTokens: 40,
          inputTokens: 100,
          outputTokens: 0,
          reasoningTokens: 0,
        },
      }),
    ).toMatchObject({
      requestCost: {
        inputCostUsd: 0.0002,
        outputCostUsd: 0,
        totalCostUsd: 0.0002,
      },
      requestUsage: {
        cachedInputTokens: 40,
        inputTokens: 100,
        tokenSource: "provider",
      },
    });
  });

  it("detects Anthropic cache read input tokens without losing uncached input tokens", () => {
    expect(
      readGatewayProviderTokenUsage({
        usage: {
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 400,
          input_tokens: 50,
          output_tokens: 20,
        },
      }),
    ).toEqual({
      cachedInputTokens: 400,
      inputTokens: 480,
      outputTokens: 20,
      reasoningTokens: 0,
    });
  });
});

function pricedModel(
  modelId: string,
  inputPrice: number,
  cachedInputPrice: number | null,
  outputPrice: number,
) {
  return {
    cachedInputUsdPerMillionTokens: cachedInputPrice ?? undefined,
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
