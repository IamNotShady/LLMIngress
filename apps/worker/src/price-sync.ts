import {
  type ConfigPublishClient,
  createConfigPublisher,
} from "@llmingress/config/config-publisher";
import { type JobHandler, JobHandlerError } from "./job-runner.js";
import {
  fetchProviderModelPrices,
  type ProviderModelPriceSource,
  type ProviderModelSyncedPrice,
} from "./price-source.js";

export type PriceSyncJobHandlerOptions = {
  databaseUrl: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  priceSource?: () => Promise<ProviderModelSyncedPrice[]>;
};

type PriceSyncPriceEntry = {
  cachedInputUsdPerMillionTokens: number | null;
  inputUsdPerMillionTokens: number;
  metadata?: Record<string, unknown>;
  modelId: string;
  outputUsdPerMillionTokens: number;
  priceVersion: string;
  source: ProviderModelPriceSource;
  providerKey: string;
  sourceUrl: string;
  syncedAt: Date;
};

type NormalizedPriceSyncPayload = {
  priceVersion: string | null;
  prices: PriceSyncPriceEntry[] | null;
};

export function createPriceSyncJobHandler(options: PriceSyncJobHandlerOptions): JobHandler {
  const now = options.now ?? (() => new Date());

  return async (job) => {
    const observedAt = now();
    const payload = normalizePriceSyncPayload(job.payload, observedAt);
    const prices =
      payload.prices ??
      (options.priceSource
        ? await options.priceSource()
        : await fetchProviderModelPrices({ fetch: options.fetch, now: () => observedAt }));
    let syncedPriceCount = 0;

    const publisher = createConfigPublisher({ databaseUrl: options.databaseUrl });
    const publishResult = await publisher.publish({
      source: "worker",
      description: `Sync provider model prices ${payload.priceVersion ?? observedAt.toISOString()}`,
      changes: [{ table: "provider_models", recordId: null }],
      write: async (client) => {
        syncedPriceCount = await writeProviderModelPrices(client, {
          jobId: job.id,
          observedAt,
          prices,
        });
      },
    });

    return {
      configVersion: publishResult.version,
      priceVersion:
        payload.priceVersion ??
        (prices.length === 1 ? prices[0]?.priceVersion : `price-sync:${observedAt.toISOString()}`),
      snapshotCount: syncedPriceCount,
      syncedPriceCount,
      trigger: job.trigger,
    };
  };
}

function normalizePriceSyncPayload(
  rawPayload: unknown,
  observedAt: Date,
): NormalizedPriceSyncPayload {
  const payload = readObject(rawPayload);
  const sourceUrl = readOptionalString(payload.sourceUrl);
  const priceVersion =
    readOptionalString(payload.priceVersion) ?? `price-sync:${observedAt.toISOString()}`;
  const prices = Array.isArray(payload.prices)
    ? payload.prices.map((price) =>
        normalizePayloadPrice(price, { observedAt, priceVersion, sourceUrl }),
      )
    : null;

  if (prices !== null && prices.length === 0) {
    throw new JobHandlerError("price_sync_empty_registry", "Price sync payload has no prices.");
  }

  return {
    priceVersion,
    prices,
  };
}

function normalizePayloadPrice(
  rawPrice: unknown,
  defaults: {
    observedAt: Date;
    priceVersion: string;
    sourceUrl: string | null;
  },
): PriceSyncPriceEntry {
  const price = readObject(rawPrice);
  const providerKey = readRequiredString(price.providerKey, "providerKey").toLowerCase();
  const modelId = readRequiredString(price.modelId, "modelId");
  const source = readPriceSource(price.source) ?? "models.dev";

  return {
    cachedInputUsdPerMillionTokens: readOptionalNonNegativeNumber(
      price.cachedInputUsdPerMillionTokens,
      `${providerKey}/${modelId} cached input price`,
    ),
    inputUsdPerMillionTokens: readRequiredNonNegativeNumber(
      price.inputUsdPerMillionTokens,
      `${providerKey}/${modelId} input price`,
    ),
    modelId,
    outputUsdPerMillionTokens: readRequiredNonNegativeNumber(
      price.outputUsdPerMillionTokens,
      `${providerKey}/${modelId} output price`,
    ),
    priceVersion: defaults.priceVersion,
    source,
    providerKey,
    sourceUrl:
      readOptionalString(price.sourceUrl) ?? defaults.sourceUrl ?? "manual://price_sync_payload",
    syncedAt: defaults.observedAt,
  };
}

async function writeProviderModelPrices(
  client: ConfigPublishClient,
  input: {
    jobId: string;
    observedAt: Date;
    prices: PriceSyncPriceEntry[];
  },
): Promise<number> {
  if (input.prices.length === 0) {
    throw new JobHandlerError("price_sync_empty_registry", "Price sync has no prices to write.");
  }

  let syncedPriceCount = 0;

  for (const price of input.prices) {
    const result = await client.query<{ id: string }>(
      `
        update provider_models
        set synced_input_usd_per_million_tokens = $3,
            synced_cached_input_usd_per_million_tokens = $4,
            synced_output_usd_per_million_tokens = $5,
            synced_price_source = $6,
            synced_price_source_url = $7,
            synced_price_version = $8,
            synced_price_synced_at = $9::timestamptz,
            synced_price_metadata = $10::jsonb,
            synced_price_updated_at = $11::timestamptz,
            updated_at = $11::timestamptz
        from providers
        where providers.id = provider_models.provider_id
          and lower(providers.provider_key) = lower($1)
          and provider_models.model_id = $2
          and providers.deleted_at is null
          and provider_models.deleted_at is null
        returning provider_models.id::text
      `,
      [
        price.providerKey,
        price.modelId,
        price.inputUsdPerMillionTokens,
        price.cachedInputUsdPerMillionTokens,
        price.outputUsdPerMillionTokens,
        price.source,
        price.sourceUrl,
        price.priceVersion,
        price.syncedAt.toISOString(),
        JSON.stringify({ ...(price.metadata ?? {}), jobId: input.jobId }),
        input.observedAt.toISOString(),
      ],
    );
    syncedPriceCount += result.rows.length;
  }

  return syncedPriceCount;
}

function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readRequiredString(value: unknown, fieldName: string): string {
  const normalized = readOptionalString(value);
  if (!normalized) {
    throw new JobHandlerError(
      "price_sync_invalid_payload",
      `Price sync payload ${fieldName} is required.`,
    );
  }
  return normalized;
}

function readOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function readPriceSource(value: unknown): ProviderModelPriceSource | null {
  const normalized = readOptionalString(value);
  if (normalized === "models.dev" || normalized === "litellm") {
    return normalized;
  }
  return null;
}

function readRequiredNonNegativeNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new JobHandlerError(
      "price_sync_invalid_payload",
      `Price sync payload ${fieldName} must be a non-negative number.`,
    );
  }
  return value;
}

function readOptionalNonNegativeNumber(value: unknown, fieldName: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return readRequiredNonNegativeNumber(value, fieldName);
}
