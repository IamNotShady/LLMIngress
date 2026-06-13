import { describe, expect, it } from "vitest";
import {
  calculateTokenCostUsd,
  resolveEffectiveModelTokenPrice,
  resolveModelTokenPrice,
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

  it("keeps the built-in price when the override belongs to a different model", () => {
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
    ).toEqual(resolveModelTokenPrice({ modelId: "gpt-4.1-mini", providerKey: "openai" }));
  });

  it("defines unique non-negative model price overrides in the database schema", () => {
    const migration = loadSqlMigrations().find((candidate) => candidate.id === "0005");

    expect(migration?.sql).toContain("create table if not exists model_price_overrides");
    expect(migration?.sql).toContain("provider_key text not null");
    expect(migration?.sql).toContain("model_id text not null");
    expect(migration?.sql).toContain("input_usd_per_million_tokens numeric(20, 8) not null");
    expect(migration?.sql).toContain("output_usd_per_million_tokens numeric(20, 8) not null");
    expect(migration?.sql).toContain("input_usd_per_million_tokens >= 0");
    expect(migration?.sql).toContain("output_usd_per_million_tokens >= 0");
    expect(migration?.sql).toContain("unique (provider_key, model_id)");
  });
});
