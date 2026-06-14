import { expect, test } from "@playwright/test";
import { calculateTokenCostUsd, resolveModelTokenPrice } from "../../packages/billing/src/index";

test("known model returns token prices unknown model returns unknown price", () => {
  const sonnet = resolveModelTokenPrice({
    modelId: "claude-sonnet-4-6",
    providerKey: "anthropic",
  });

  expect(sonnet).toMatchObject({
    inputUsdPerMillionTokens: 3,
    outputUsdPerMillionTokens: 15,
    status: "priced",
  });
  expect(
    calculateTokenCostUsd(sonnet, { inputTokens: 2_000_000, outputTokens: 1_000_000 }),
  ).toEqual({
    inputCostUsd: 6,
    outputCostUsd: 15,
    status: "estimated",
    totalCostUsd: 21,
  });

  expect(
    resolveModelTokenPrice({
      modelId: "custom-unpriced-model",
      providerKey: "openai-compatible",
    }),
  ).toMatchObject({
    reason: "model_not_in_builtin_registry",
    status: "unknown_price",
  });
});
