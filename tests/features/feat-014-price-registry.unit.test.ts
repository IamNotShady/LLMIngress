import { describe, expect, it } from "vitest";
import {
  BUILT_IN_PRICE_REGISTRY_VERSION,
  calculateTokenCostUsd,
  resolveModelTokenPrice,
} from "../../packages/billing/src/price-registry";

describe("feat-014 static price registry", () => {
  it("resolves known MVP model input and output token prices from the built-in snapshot", () => {
    expect(BUILT_IN_PRICE_REGISTRY_VERSION).toBe("mvp-static-2026-06-13");

    const openaiPrice = resolveModelTokenPrice({
      modelId: "gpt-4.1-mini",
      providerKey: "openai",
    });
    expect(openaiPrice).toMatchObject({
      currency: "USD",
      inputUsdPerMillionTokens: 0.4,
      modelId: "gpt-4.1-mini",
      outputUsdPerMillionTokens: 1.6,
      providerKey: "openai",
      source: "built_in_static_snapshot",
      status: "priced",
      unit: "per_1m_tokens",
    });

    const anthropicPrice = resolveModelTokenPrice({
      modelId: "claude-haiku-4-5",
      providerKey: "anthropic",
    });
    expect(anthropicPrice).toMatchObject({
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 5,
      status: "priced",
    });
  });

  it("returns explicit unknown_price for models absent from the built-in snapshot", () => {
    expect(
      resolveModelTokenPrice({
        modelId: "not-a-real-model",
        providerKey: "openai",
      }),
    ).toEqual({
      modelId: "not-a-real-model",
      priceVersion: BUILT_IN_PRICE_REGISTRY_VERSION,
      providerKey: "openai",
      reason: "model_not_in_builtin_registry",
      status: "unknown_price",
    });
  });

  it("estimates token cost without rounding unknown prices to zero", () => {
    const price = resolveModelTokenPrice({
      modelId: "gpt-4.1-mini",
      providerKey: "openai",
    });

    expect(calculateTokenCostUsd(price, { inputTokens: 1_000, outputTokens: 500 })).toEqual({
      inputCostUsd: 0.0004,
      outputCostUsd: 0.0008,
      status: "estimated",
      totalCostUsd: 0.0012,
    });

    expect(
      calculateTokenCostUsd(
        resolveModelTokenPrice({ modelId: "unknown", providerKey: "anthropic" }),
        { inputTokens: 1_000, outputTokens: 500 },
      ),
    ).toEqual({
      reason: "unknown_price",
      status: "unavailable",
    });
  });
});
