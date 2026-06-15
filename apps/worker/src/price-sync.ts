import { randomUUID } from "node:crypto";
import { listBuiltInModelTokenPrices } from "@llmingress/billing/price-registry";
import {
  type ConfigPublishClient,
  createConfigPublisher,
} from "@llmingress/config/config-publisher";
import { type JobHandler, JobHandlerError } from "./job-runner.js";

export type PriceSyncJobHandlerOptions = {
  databaseUrl: string;
  now?: () => Date;
};

type PriceSyncPriceEntry = {
  cachedInputUsdPerMillionTokens: number | null;
  inputUsdPerMillionTokens: number;
  modelId: string;
  outputUsdPerMillionTokens: number;
  providerKey: string;
  sourceUrl: string | null;
};

type NormalizedPriceSyncPayload = {
  priceVersion: string;
  prices: PriceSyncPriceEntry[];
};

export function createPriceSyncJobHandler(options: PriceSyncJobHandlerOptions): JobHandler {
  const now = options.now ?? (() => new Date());

  return async (job) => {
    const observedAt = now();
    const payload = normalizePriceSyncPayload(job.payload, observedAt);
    let snapshotCount = 0;

    const publisher = createConfigPublisher({ databaseUrl: options.databaseUrl });
    const publishResult = await publisher.publish({
      source: "worker",
      description: `Sync model prices ${payload.priceVersion}`,
      changes: [{ table: "price_registry_snapshots", recordId: null }],
      write: async (client) => {
        snapshotCount = await writePriceSnapshots(client, {
          jobId: job.id,
          observedAt,
          payload,
        });
      },
    });

    return {
      configVersion: publishResult.version,
      priceVersion: payload.priceVersion,
      snapshotCount,
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
    ? payload.prices.map((price) => normalizePayloadPrice(price, sourceUrl))
    : listBuiltInModelTokenPrices().map((price) => ({
        cachedInputUsdPerMillionTokens: price.cachedInputUsdPerMillionTokens ?? null,
        inputUsdPerMillionTokens: price.inputUsdPerMillionTokens,
        modelId: price.modelId,
        outputUsdPerMillionTokens: price.outputUsdPerMillionTokens,
        providerKey: price.providerKey,
        sourceUrl: price.sourceUrl,
      }));

  if (prices.length === 0) {
    throw new JobHandlerError("price_sync_empty_registry", "Price sync payload has no prices.");
  }

  return {
    priceVersion,
    prices,
  };
}

function normalizePayloadPrice(
  rawPrice: unknown,
  defaultSourceUrl: string | null,
): PriceSyncPriceEntry {
  const price = readObject(rawPrice);
  const providerKey = readRequiredString(price.providerKey, "providerKey").toLowerCase();
  const modelId = readRequiredString(price.modelId, "modelId");

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
    providerKey,
    sourceUrl: readOptionalString(price.sourceUrl) ?? defaultSourceUrl,
  };
}

async function writePriceSnapshots(
  client: ConfigPublishClient,
  input: {
    jobId: string;
    observedAt: Date;
    payload: NormalizedPriceSyncPayload;
  },
): Promise<number> {
  let snapshotCount = 0;

  for (const price of input.payload.prices) {
    const result = await client.query<{ id: string }>(
      `
        insert into price_registry_snapshots (
          id,
          job_id,
          provider_key,
          model_id,
          input_usd_per_million_tokens,
          cached_input_usd_per_million_tokens,
          output_usd_per_million_tokens,
          source,
          source_url,
          price_version,
          snapshot_at,
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
          'price_sync',
          $8,
          $9,
          $10::timestamptz,
          '{}'::jsonb,
          $10::timestamptz
        )
        on conflict (provider_key, model_id, price_version)
        do update set
          job_id = excluded.job_id,
          input_usd_per_million_tokens = excluded.input_usd_per_million_tokens,
          cached_input_usd_per_million_tokens = excluded.cached_input_usd_per_million_tokens,
          output_usd_per_million_tokens = excluded.output_usd_per_million_tokens,
          source = excluded.source,
          source_url = excluded.source_url,
          snapshot_at = excluded.snapshot_at,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at
        returning id::text
      `,
      [
        randomUUID(),
        input.jobId,
        price.providerKey,
        price.modelId,
        price.inputUsdPerMillionTokens,
        price.cachedInputUsdPerMillionTokens,
        price.outputUsdPerMillionTokens,
        price.sourceUrl,
        input.payload.priceVersion,
        input.observedAt.toISOString(),
      ],
    );
    snapshotCount += result.rows.length;
  }

  return snapshotCount;
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
