import { randomUUID } from "node:crypto";
import { listProviderModelOptions } from "@llmingress/db/console-route-policies";
import { afterEach, describe, expect, it } from "vitest";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

describe("feat-057 provider model price status", () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  });

  it("resolves provider model options to synced manual and unknown price statuses", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_price_status_unit_${randomUUID().replaceAll("-", "_")}`,
    });
    fixtures.push(fixture);

    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedProviderModels(fixture);

    const options = await listProviderModelOptions(fixture.databaseUrl);

    expect(
      options.map((option) => ({
        modelId: option.modelId,
        optionLabel: option.optionLabel,
        pricedOptionLabel: option.pricedOptionLabel,
        priceStatusLabel: option.priceStatusLabel,
      })),
    ).toEqual([
      {
        modelId: "gpt-4.1-mini",
        optionLabel: "OpenAI Test Provider - GPT-4.1 Mini (gpt-4.1-mini)",
        pricedOptionLabel:
          "OpenAI Test Provider - GPT-4.1 Mini (gpt-4.1-mini) - Priced (price sync)",
        priceStatusLabel: "Priced (price sync)",
      },
      {
        modelId: "manual-priced-model",
        optionLabel: "OpenAI Test Provider - Manual Priced Model (manual-priced-model)",
        pricedOptionLabel:
          "OpenAI Test Provider - Manual Priced Model (manual-priced-model) - Priced (manual override)",
        priceStatusLabel: "Priced (manual override)",
      },
      {
        modelId: "unknown-refresh-model",
        optionLabel: "OpenAI Test Provider - Unknown Refresh Model (unknown-refresh-model)",
        pricedOptionLabel:
          "OpenAI Test Provider - Unknown Refresh Model (unknown-refresh-model) - Unknown price",
        priceStatusLabel: "Unknown price",
      },
    ]);
  });
});

async function seedProviderModels(fixture: Fixture): Promise<void> {
  const providerId = randomUUID();
  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'OpenAI Test Provider', 'https://api.openai.com/v1', true)
    `,
    [providerId],
  );
  await fixture.query(
    `
      insert into provider_models (id, provider_id, model_id, display_name, availability)
      values
        ($1, $5, 'gpt-4.1-mini', 'GPT-4.1 Mini', 'available'),
        ($2, $5, 'manual-priced-model', 'Manual Priced Model', 'available'),
        ($3, $5, 'not-listed-model', 'Not Listed Model', 'not_listed'),
        ($4, $5, 'unknown-refresh-model', 'Unknown Refresh Model', 'available')
    `,
    [randomUUID(), randomUUID(), randomUUID(), randomUUID(), providerId],
  );
  await fixture.query(
    `
      update provider_models
      set manual_input_usd_per_million_tokens = 2.50,
          manual_output_usd_per_million_tokens = 7.50,
          manual_price_updated_at = now()
      where provider_id = $1
        and model_id = 'manual-priced-model'
    `,
    [providerId],
  );
  await fixture.query(
    `
      update provider_models
      set synced_input_usd_per_million_tokens = 0.40,
          synced_output_usd_per_million_tokens = 1.60,
          synced_price_source = 'models.dev',
          synced_price_source_url = 'https://models.dev/api.json',
          synced_price_version = 'models.dev:test',
          synced_price_synced_at = now(),
          synced_price_updated_at = now()
      where provider_id = $1
        and model_id = 'gpt-4.1-mini'
    `,
    [providerId],
  );
}
