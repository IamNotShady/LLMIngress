import { describe, expect, it } from "vitest";
import { resolveEffectiveModelTokenPrice } from "../../packages/billing/src/index";
import { loadSqlMigrations } from "../../packages/db/src/index";

describe("feat-073 price sync job", () => {
  it("declares provider model prices for synced prices", () => {
    const migration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0024" && candidate.name === "provider_model_prices",
    );

    expect(migration?.sql).toContain("create table if not exists provider_models_price");
    expect(migration?.sql).toContain("cached_input_usd_per_million_tokens numeric(20, 8)");
    expect(migration?.sql).toContain("unique (provider_key, model_id, source)");
    expect(migration?.sql).toContain("idx_provider_models_price_effective");
  });

  it("uses synced prices when no manual override exists and keeps manual overrides first", () => {
    const syncedPrice = {
      cachedInputUsdPerMillionTokens: 0.25,
      inputUsdPerMillionTokens: 1,
      modelId: "synced-model",
      outputUsdPerMillionTokens: 3,
      priceVersion: "price-sync:test",
      providerKey: "synced-provider",
      sourceUrl: "test://prices",
      syncedAt: new Date("2026-06-16T00:00:00.000Z"),
    };

    expect(
      resolveEffectiveModelTokenPrice({
        modelId: "synced-model",
        providerKey: "synced-provider",
        syncedPrice,
      }),
    ).toMatchObject({
      cachedInputUsdPerMillionTokens: 0.25,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 3,
      priceVersion: "price-sync:test",
      providerKey: "synced-provider",
      source: "price_sync",
      status: "priced",
    });
    expect(
      resolveEffectiveModelTokenPrice({
        manualOverride: {
          inputUsdPerMillionTokens: 9,
          modelId: "synced-model",
          outputUsdPerMillionTokens: 10,
          providerKey: "synced-provider",
          updatedAt: new Date("2026-06-16T01:00:00.000Z"),
        },
        modelId: "synced-model",
        providerKey: "synced-provider",
        syncedPrice,
      }),
    ).toMatchObject({
      inputUsdPerMillionTokens: 9,
      outputUsdPerMillionTokens: 10,
      source: "manual_override",
    });
  });
});
