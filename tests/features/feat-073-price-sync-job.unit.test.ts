import { randomUUID } from "node:crypto";
import { createPriceSyncJobHandler } from "@llmingress/db/worker-price-sync";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEffectiveModelTokenPrice } from "../../packages/billing/src/index";
import {
  createTestPostgresFixture,
  loadSqlMigrations,
  runMigrations,
} from "../../packages/db/src/index";

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

describe("feat-073 price sync job", () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  });

  it("declares provider model fields for synced prices", () => {
    const migration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0036" && candidate.name === "merge_provider_model_prices",
    );

    expect(migration?.sql).toContain("alter table provider_models");
    expect(migration?.sql).toContain("synced_cached_input_usd_per_million_tokens numeric(20, 8)");
    expect(migration?.sql).toContain("synced_price_source text");
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

  it("syncs base provider prices onto subscription provider models", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_price_sync_subscription_${randomUUID().replaceAll("-", "_")}`,
    });
    fixtures.push(fixture);

    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const providerId = randomUUID();
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'subscription', 'openai_codex', 'OpenAI Codex', 'https://chatgpt.com/backend-api', true)
      `,
      [providerId],
    );
    await fixture.query(
      `
        insert into provider_models (id, provider_id, model_id, display_name, availability)
        values ($1, $2, 'gpt-5.4', 'GPT-5.4', 'available')
      `,
      [randomUUID(), providerId],
    );

    const handler = createPriceSyncJobHandler({
      databaseUrl: fixture.databaseUrl,
      now: () => new Date("2026-06-22T00:00:00.000Z"),
      priceSource: async () => [
        {
          cachedInputUsdPerMillionTokens: null,
          inputUsdPerMillionTokens: 2.5,
          modelId: "gpt-5.4",
          outputUsdPerMillionTokens: 15,
          priceVersion: "price-sync:test",
          providerKey: "openai",
          source: "models.dev",
          sourceUrl: "https://models.dev/api.json",
          syncedAt: new Date("2026-06-22T00:00:00.000Z"),
        },
      ],
    });

    await handler({
      attemptNumber: 1,
      id: randomUUID(),
      jobType: "price_sync",
      maxAttempts: 1,
      payload: {},
      priority: 0,
      trigger: "manual",
      workerId: "worker-test",
    });

    const result = await fixture.query<{
      input_price: string | null;
      output_price: string | null;
      price_source: string | null;
    }>(
      `
        select synced_input_usd_per_million_tokens::text as input_price,
               synced_output_usd_per_million_tokens::text as output_price,
               synced_price_source as price_source
        from provider_models
        where provider_id = $1
          and model_id = 'gpt-5.4'
      `,
      [providerId],
    );

    expect(result.rows[0]).toEqual({
      input_price: "2.50000000",
      output_price: "15.00000000",
      price_source: "models.dev",
    });
  });
});
