import { randomUUID } from "node:crypto";
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
      changes: [{ table: "provider_models_price", recordId: null }],
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
        insert into provider_models_price (
          id,
          provider_key,
          model_id,
          input_usd_per_million_tokens,
          cached_input_usd_per_million_tokens,
          output_usd_per_million_tokens,
          source,
          source_url,
          price_version,
          synced_at,
          metadata,
          updated_at
        )
        values (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10::timestamptz,
          $11::jsonb,
          $12::timestamptz
        )
        on conflict (provider_key, model_id, source)
        do update set
          input_usd_per_million_tokens = excluded.input_usd_per_million_tokens,
          cached_input_usd_per_million_tokens = excluded.cached_input_usd_per_million_tokens,
          output_usd_per_million_tokens = excluded.output_usd_per_million_tokens,
          source_url = excluded.source_url,
          price_version = excluded.price_version,
          synced_at = excluded.synced_at,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at
        returning id::text
      `,
      [
        randomUUID(),
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
