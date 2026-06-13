import { randomUUID } from "node:crypto";
import type { ManualPriceOverride } from "@llmingress/billing/price-registry";
import { createConfigPublisher } from "@llmingress/config/config-publisher";
import { Client, type QueryResultRow } from "pg";

type PriceOverrideRow = QueryResultRow & {
  input_usd_per_million_tokens: string;
  model_id: string;
  output_usd_per_million_tokens: string;
  provider_key: string;
  updated_at: Date;
};

export async function getManualPriceOverride(input: {
  databaseUrl: string;
  modelId: string;
  providerKey: string;
}): Promise<ManualPriceOverride | null> {
  return withClient(input.databaseUrl, async (client) => {
    const result = await client.query<PriceOverrideRow>(
      `
        select provider_key,
               model_id,
               input_usd_per_million_tokens::text,
               output_usd_per_million_tokens::text,
               updated_at
        from model_price_overrides
        where provider_key = $1
          and model_id = $2
      `,
      [normalizeProviderKey(input.providerKey), input.modelId.trim()],
    );

    const row = result.rows[0];
    return row ? rowToManualPriceOverride(row) : null;
  });
}

export async function saveManualPriceOverride(input: {
  databaseUrl: string;
  inputUsdPerMillionTokens: number;
  modelId: string;
  outputUsdPerMillionTokens: number;
  providerKey: string;
}): Promise<ManualPriceOverride> {
  assertPrice(input.inputUsdPerMillionTokens);
  assertPrice(input.outputUsdPerMillionTokens);

  const providerKey = normalizeProviderKey(input.providerKey);
  const modelId = input.modelId.trim();
  let saved: ManualPriceOverride | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Update manual price override for ${providerKey}/${modelId}`,
    changes: [{ table: "model_price_overrides", recordId: null }],
    write: async (client) => {
      const result = await client.query<PriceOverrideRow>(
        `
          insert into model_price_overrides (
            id,
            provider_key,
            model_id,
            input_usd_per_million_tokens,
            output_usd_per_million_tokens
          )
          values ($1, $2, $3, $4, $5)
          on conflict (provider_key, model_id)
          do update set
            input_usd_per_million_tokens = excluded.input_usd_per_million_tokens,
            output_usd_per_million_tokens = excluded.output_usd_per_million_tokens,
            updated_at = now()
          returning provider_key,
                    model_id,
                    input_usd_per_million_tokens::text,
                    output_usd_per_million_tokens::text,
                    updated_at
        `,
        [
          randomUUID(),
          providerKey,
          modelId,
          input.inputUsdPerMillionTokens,
          input.outputUsdPerMillionTokens,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error("Manual price override was not saved.");
      }
      saved = rowToManualPriceOverride(row);
    },
  });

  if (!saved) {
    throw new Error("Manual price override was not saved.");
  }
  return saved;
}

function rowToManualPriceOverride(row: PriceOverrideRow): ManualPriceOverride {
  return {
    inputUsdPerMillionTokens: Number(row.input_usd_per_million_tokens),
    modelId: row.model_id,
    outputUsdPerMillionTokens: Number(row.output_usd_per_million_tokens),
    providerKey: row.provider_key,
    updatedAt: row.updated_at,
  };
}

function assertPrice(price: number): void {
  if (!Number.isFinite(price) || price < 0) {
    throw new Error("Price must be a non-negative number.");
  }
}

function normalizeProviderKey(providerKey: string): string {
  return providerKey.trim().toLowerCase();
}

async function withClient<T>(
  databaseUrl: string,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}
