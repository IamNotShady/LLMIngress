import { describe, expect, it } from "vitest";
import { resolveEffectiveModelTokenPrice } from "../../packages/billing/src/index";
import { loadSqlMigrations } from "../../packages/db/src/index";

describe("feat-100 provider model price source", () => {
  it("declares provider model current price schema and removes legacy price tables", () => {
    const migration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0024" && candidate.name === "provider_model_prices",
    );
    const sql = migration?.sql ?? "";

    expect(sql).toContain("alter table provider_models");
    expect(sql).toContain("manual_input_usd_per_million_tokens numeric(20, 8)");
    expect(sql).toContain("manual_cached_input_usd_per_million_tokens numeric(20, 8)");
    expect(sql).toContain("manual_output_usd_per_million_tokens numeric(20, 8)");
    expect(sql).toContain("manual_price_updated_at timestamptz");
    expect(sql).toContain("create table if not exists provider_models_price");
    expect(sql).toContain("source text not null check (source in ('models.dev', 'litellm'))");
    expect(sql).toContain("unique (provider_key, model_id, source)");
    expect(sql).toContain("idx_provider_models_price_effective");
    expect(sql).toContain("drop table if exists model_price_overrides");
    expect(sql).toContain("drop table if exists price_registry_snapshots");
    expect(sql).not.toContain("from model_price_overrides");
    expect(sql).not.toContain("from price_registry_snapshots");
  });

  it("normalizes models.dev primary prices and LiteLLM auxiliary prices with primary precedence", async () => {
    const {
      mergeProviderModelPrices,
      normalizeLiteLlmProviderModelPrices,
      normalizeModelsDevProviderModelPrices,
    } = await import("../../apps/worker/src/price-source");
    const syncedAt = new Date("2026-06-17T00:00:00.000Z");

    const primaryPrices = normalizeModelsDevProviderModelPrices(
      {
        "fireworks-ai": {
          models: {
            "accounts/fireworks/models/llama-v3": {
              cost: { cache_read: 0.08, input: 0.2, output: 0.6 },
              id: "accounts/fireworks/models/llama-v3",
            },
          },
        },
        google: {
          models: {
            "gemini-2.5-pro": {
              cost: { input: 1.25, output: 10 },
              id: "gemini-2.5-pro",
            },
          },
        },
        moonshotai: {
          models: {
            "kimi-k2": {
              cost: { input: 0.15, output: 2.5 },
              id: "kimi-k2",
            },
          },
        },
        openai: {
          models: {
            "gpt-primary": {
              cost: { cache_read: 0.25, input: 1, output: 3 },
              id: "gpt-primary",
            },
            "gpt-shared": {
              cost: { input: 2, output: 8 },
              id: "gpt-shared",
            },
          },
        },
      },
      { sourceUrl: "https://models.dev/api.json", syncedAt },
    );
    const auxiliaryPrices = normalizeLiteLlmProviderModelPrices(
      {
        "gpt-secondary": {
          input_cost_per_token: 0.000001,
          litellm_provider: "openai",
          output_cost_per_token: 0.000004,
        },
        "gpt-shared": {
          cache_read_input_token_cost: 0.0000005,
          input_cost_per_token: 0.0000025,
          litellm_provider: "openai",
          output_cost_per_token: 0.000009,
        },
        sample_spec: {
          input_cost_per_token: 1,
          litellm_provider: "openai",
          output_cost_per_token: 1,
        },
      },
      {
        sourceUrl:
          "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
        syncedAt,
      },
    );

    expect(primaryPrices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cachedInputUsdPerMillionTokens: 0.25,
          inputUsdPerMillionTokens: 1,
          modelId: "gpt-primary",
          outputUsdPerMillionTokens: 3,
          providerKey: "openai",
          source: "models.dev",
        }),
        expect.objectContaining({
          modelId: "gemini-2.5-pro",
          providerKey: "gemini",
        }),
        expect.objectContaining({
          modelId: "kimi-k2",
          providerKey: "moonshot",
        }),
        expect.objectContaining({
          modelId: "accounts/fireworks/models/llama-v3",
          providerKey: "fireworks",
        }),
      ]),
    );
    expect(auxiliaryPrices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inputUsdPerMillionTokens: 1,
          modelId: "gpt-secondary",
          outputUsdPerMillionTokens: 4,
          providerKey: "openai",
          source: "litellm",
        }),
        expect.objectContaining({
          cachedInputUsdPerMillionTokens: 0.5,
          inputUsdPerMillionTokens: 2.5,
          modelId: "gpt-shared",
          outputUsdPerMillionTokens: 9,
          providerKey: "openai",
          source: "litellm",
        }),
      ]),
    );

    const merged = mergeProviderModelPrices(primaryPrices, auxiliaryPrices);

    expect(
      merged.filter((price) => price.providerKey === "openai" && price.modelId === "gpt-shared"),
    ).toEqual([
      expect.objectContaining({
        inputUsdPerMillionTokens: 2,
        outputUsdPerMillionTokens: 8,
        source: "models.dev",
      }),
    ]);
    expect(merged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelId: "gpt-secondary",
          providerKey: "openai",
          source: "litellm",
        }),
      ]),
    );
  });

  it("resolves current prices from provider_models manual fields, then provider_models_price, then unknown", () => {
    expect(
      resolveEffectiveModelTokenPrice({
        modelId: "gpt-4.1-mini",
        providerKey: "openai",
      }),
    ).toMatchObject({
      modelId: "gpt-4.1-mini",
      providerKey: "openai",
      reason: "no_current_price",
      status: "unknown_price",
    });

    const synced = resolveEffectiveModelTokenPrice({
      modelId: "synced-model",
      providerKey: "openai",
      syncedPrice: {
        cachedInputUsdPerMillionTokens: 0.2,
        inputUsdPerMillionTokens: 1,
        modelId: "synced-model",
        outputUsdPerMillionTokens: 3,
        priceVersion: "models.dev:2026-06-17T00:00:00.000Z",
        providerKey: "openai",
        sourceUrl: "https://models.dev/api.json",
        syncedAt: new Date("2026-06-17T00:00:00.000Z"),
      },
    });

    expect(synced).toMatchObject({
      cachedInputUsdPerMillionTokens: 0.2,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 3,
      source: "price_sync",
      status: "priced",
    });

    const manual = resolveEffectiveModelTokenPrice({
      manualOverride: {
        cachedInputUsdPerMillionTokens: 4,
        inputUsdPerMillionTokens: 5,
        modelId: "synced-model",
        outputUsdPerMillionTokens: 6,
        providerKey: "openai",
        updatedAt: new Date("2026-06-17T00:01:00.000Z"),
      },
      modelId: "synced-model",
      providerKey: "openai",
      syncedPrice: {
        inputUsdPerMillionTokens: 1,
        modelId: "synced-model",
        outputUsdPerMillionTokens: 3,
        priceVersion: "models.dev:2026-06-17T00:00:00.000Z",
        providerKey: "openai",
        sourceUrl: "https://models.dev/api.json",
        syncedAt: new Date("2026-06-17T00:00:00.000Z"),
      },
    });

    expect(manual).toMatchObject({
      cachedInputUsdPerMillionTokens: 4,
      inputUsdPerMillionTokens: 5,
      outputUsdPerMillionTokens: 6,
      source: "manual_override",
      sourceUrl: "manual://provider_models",
      status: "priced",
    });
  });
});
