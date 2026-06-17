import { describe, expect, it } from "vitest";
import {
  calculateTokenCostUsd,
  resolveEffectiveModelTokenPrice,
} from "../../packages/billing/src/index";
import { loadSqlMigrations } from "../../packages/db/src/index";

describe("feat-015 model price override management", () => {
  it("uses a matching manual price override instead of the built-in price", () => {
    const price = resolveEffectiveModelTokenPrice({
      manualOverride: {
        inputUsdPerMillionTokens: 9,
        modelId: "gpt-4.1-mini",
        outputUsdPerMillionTokens: 10,
        providerKey: "openai",
        updatedAt: new Date("2026-06-13T00:00:00.000Z"),
      },
      modelId: "gpt-4.1-mini",
      providerKey: "openai",
    });

    expect(price).toMatchObject({
      inputUsdPerMillionTokens: 9,
      outputUsdPerMillionTokens: 10,
      source: "manual_override",
      status: "priced",
    });
    expect(
      calculateTokenCostUsd(price, { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toEqual({
      inputCostUsd: 9,
      outputCostUsd: 10,
      status: "estimated",
      totalCostUsd: 19,
    });
  });

  it("returns unknown current price when the manual price belongs to a different model", () => {
    expect(
      resolveEffectiveModelTokenPrice({
        manualOverride: {
          inputUsdPerMillionTokens: 9,
          modelId: "different-model",
          outputUsdPerMillionTokens: 10,
          providerKey: "openai",
          updatedAt: new Date("2026-06-13T00:00:00.000Z"),
        },
        modelId: "gpt-4.1-mini",
        providerKey: "openai",
      }),
    ).toMatchObject({
      modelId: "gpt-4.1-mini",
      providerKey: "openai",
      reason: "no_current_price",
      status: "unknown_price",
    });
  });

  it("stores manual model prices on provider_models in the current schema", () => {
    const migration = loadSqlMigrations().find((candidate) => candidate.id === "0024");

    expect(migration?.sql).toContain("alter table provider_models");
    expect(migration?.sql).toContain("manual_input_usd_per_million_tokens numeric(20, 8)");
    expect(migration?.sql).toContain("manual_output_usd_per_million_tokens numeric(20, 8)");
    expect(migration?.sql).toContain("manual_price_updated_at timestamptz");
    expect(migration?.sql).toContain("drop table if exists model_price_overrides");
  });
});
