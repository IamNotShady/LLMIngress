import type { ManualPriceOverride } from "@llmingress/billing/price-registry";
import type { PostgresQueryResultRow } from "@llmingress/db/client";
import { createConfigPublisher } from "@llmingress/db/config-versions";
import { buildManualPriceOverride } from "./price-rows.ts";

type PriceOverrideRow = PostgresQueryResultRow & {
  id: string;
  cached_input_usd_per_million_tokens: string | null;
  input_usd_per_million_tokens: string;
  model_id: string;
  output_usd_per_million_tokens: string;
  provider_key: string;
  manual_price_updated_at: Date;
};

export async function saveManualPriceOverride(input: {
  databaseUrl?: string;
  inputUsdPerMillionTokens: number;
  modelId: string;
  outputUsdPerMillionTokens: number;
  providerKey: string;
}): Promise<ManualPriceOverride> {
  assertPrice(input.inputUsdPerMillionTokens);
  assertPrice(input.outputUsdPerMillionTokens);

  const providerKey = normalizeProviderKey(input.providerKey);
  const modelId = input.modelId.trim();
  let saved: ManualPriceOverride | null | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Update manual price override for ${providerKey}/${modelId}`,
    changes: [{ table: "provider_models", recordId: null }],
    write: async (client) => {
      const result = await client.query<PriceOverrideRow>(
        `
          update provider_models
          set manual_input_usd_per_million_tokens = $3,
              manual_output_usd_per_million_tokens = $4,
              manual_price_updated_at = now(),
              updated_at = now()
          from providers
          where providers.id = provider_models.provider_id
            and lower(providers.provider_key) = lower($1)
            and provider_models.model_id = $2
            and providers.deleted_at is null
            and provider_models.deleted_at is null
          returning provider_models.id::text as id,
                    providers.provider_key,
                    provider_models.model_id,
                    provider_models.manual_input_usd_per_million_tokens::text
                      as input_usd_per_million_tokens,
                    provider_models.manual_cached_input_usd_per_million_tokens::text
                      as cached_input_usd_per_million_tokens,
                    provider_models.manual_output_usd_per_million_tokens::text
                      as output_usd_per_million_tokens,
                    provider_models.manual_price_updated_at
        `,
        [providerKey, modelId, input.inputUsdPerMillionTokens, input.outputUsdPerMillionTokens],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error("Manual price override was not saved.");
      }
      saved = buildManualPriceOverride({
        cachedInputUsdPerMillionTokens: row.cached_input_usd_per_million_tokens,
        inputUsdPerMillionTokens: row.input_usd_per_million_tokens,
        modelId: row.model_id,
        outputUsdPerMillionTokens: row.output_usd_per_million_tokens,
        providerKey: row.provider_key,
        updatedAt: row.manual_price_updated_at,
      });
    },
  });

  if (!saved) {
    throw new Error("Manual price override was not saved.");
  }
  return saved;
}

function assertPrice(price: number): void {
  if (!Number.isFinite(price) || price < 0) {
    throw new Error("Price must be a non-negative number.");
  }
}

function normalizeProviderKey(providerKey: string): string {
  return providerKey.trim().toLowerCase();
}
