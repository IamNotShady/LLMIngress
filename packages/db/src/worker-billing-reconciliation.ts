import {
  calculateTokenCostUsd,
  type ManualPriceOverride,
  type ModelTokenPrice,
  resolveEffectiveModelTokenPrice,
  type SyncedPriceSnapshot,
} from "@llmingress/billing/price-registry";
import { PostgresClient, type PostgresQueryResultRow } from "@llmingress/db/maintenance";
import { type JobHandler, JobHandlerError } from "./worker-job-runner.ts";

export type BillingReconciliationJobHandlerOptions = {
  databaseUrl?: string;
  now?: () => Date;
};

export type BillingReconciliationUsage = {
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
};

export type BillingReconciliationCurrentCost = {
  costSource: string;
  inputCostUsd: number | null;
  outputCostUsd: number | null;
  priceSource: string | null;
  priceVersion: string | null;
  totalCostUsd: number | null;
};

export type BillingReconciliationProviderCost = {
  inputCostUsd?: number | null;
  outputCostUsd?: number | null;
  priceSource?: string | null;
  priceVersion: string;
  totalCostUsd: number;
};

export type BillingReconciliationUpdate = {
  itemStatus: "skipped" | "updated";
  newCost: {
    costSource: "provider" | "reconciled" | "unavailable";
    inputCostUsd: number | null;
    outputCostUsd: number | null;
    priceSource: string;
    priceVersion: string;
    totalCostUsd: number | null;
  };
  newSavings: {
    actualCostUsd: number | null;
    savingsPercent: number | null;
    savingsUsd: number | null;
  };
  reconciliationSource: "price_data" | "provider_actual";
  skipReason?: string;
};

type NormalizedBillingReconciliationPayload = {
  providerCostsByRequestId: Map<string, BillingReconciliationProviderCost>;
  requestIds: string[];
};

type BillingReconciliationCandidateRow = PostgresQueryResultRow & {
  activity_id: string;
  baseline_cost_usd: string | null;
  cached_input_tokens: number;
  cost_source: string;
  input_cost_usd: string | null;
  input_tokens: number;
  manual_cached_input_usd_per_million_tokens: string | null;
  manual_input_usd_per_million_tokens: string | null;
  manual_output_usd_per_million_tokens: string | null;
  manual_updated_at: Date | null;
  model_id: string;
  output_cost_usd: string | null;
  output_tokens: number;
  price_source: string | null;
  price_version: string | null;
  provider_key: string;
  request_cost_id: string;
  request_id: string;
  savings_usd: string | null;
  synced_at: Date | null;
  synced_cached_input_usd_per_million_tokens: string | null;
  synced_input_usd_per_million_tokens: string | null;
  synced_output_usd_per_million_tokens: string | null;
  synced_price_version: string | null;
  synced_source_url: string | null;
  total_cost_usd: string | null;
};

type BillingReconciliationCounts = {
  scannedRequestCount: number;
  skippedRequestCount: number;
  updatedRequestCount: number;
};

export function createBillingReconciliationJobHandler(
  options: BillingReconciliationJobHandlerOptions,
): JobHandler {
  const now = options.now ?? (() => new Date());

  return async (job) => {
    const observedAt = now();
    const payload = normalizeBillingReconciliationPayload(job.payload);
    const client = new PostgresClient({ connectionString: options.databaseUrl });
    await client.connect();

    try {
      await client.query("begin");
      const counts = await reconcileCandidateRequests(client, {
        observedAt,
        payload,
      });
      await client.query("commit");

      return counts;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  };
}

export function buildBillingReconciliationUpdate(input: {
  baselineCostUsd: number | null;
  currentCost: BillingReconciliationCurrentCost;
  price: ModelTokenPrice | null;
  providerCost: BillingReconciliationProviderCost | null;
  usage: BillingReconciliationUsage;
}): BillingReconciliationUpdate {
  if (input.providerCost) {
    const newCost = {
      costSource: "provider" as const,
      inputCostUsd: input.providerCost.inputCostUsd ?? null,
      outputCostUsd: input.providerCost.outputCostUsd ?? null,
      priceSource: input.providerCost.priceSource ?? "provider_billing",
      priceVersion: input.providerCost.priceVersion,
      totalCostUsd: roundUsd(input.providerCost.totalCostUsd),
    };
    return buildUpdateResult({
      baselineCostUsd: input.baselineCostUsd,
      currentCost: input.currentCost,
      newCost,
      reconciliationSource: "provider_actual",
    });
  }

  if (!input.price || input.price.status === "unknown_price") {
    return {
      itemStatus: "skipped",
      newCost: {
        costSource: "unavailable",
        inputCostUsd: input.currentCost.inputCostUsd,
        outputCostUsd: input.currentCost.outputCostUsd,
        priceSource: input.currentCost.priceSource ?? "unavailable",
        priceVersion: input.currentCost.priceVersion ?? "unavailable",
        totalCostUsd: input.currentCost.totalCostUsd,
      },
      newSavings: {
        actualCostUsd: input.currentCost.totalCostUsd,
        savingsPercent: null,
        savingsUsd: null,
      },
      reconciliationSource: "price_data",
      skipReason: "price_unavailable",
    };
  }

  const calculated = calculateTokenCostUsd(input.price, {
    cachedInputTokens: input.usage.cachedInputTokens,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
  });
  if (calculated.status === "unavailable") {
    return {
      itemStatus: "skipped",
      newCost: {
        costSource: "unavailable",
        inputCostUsd: input.currentCost.inputCostUsd,
        outputCostUsd: input.currentCost.outputCostUsd,
        priceSource: "unavailable",
        priceVersion: input.price.priceVersion,
        totalCostUsd: input.currentCost.totalCostUsd,
      },
      newSavings: {
        actualCostUsd: input.currentCost.totalCostUsd,
        savingsPercent: null,
        savingsUsd: null,
      },
      reconciliationSource: "price_data",
      skipReason: "cost_unavailable",
    };
  }

  return buildUpdateResult({
    baselineCostUsd: input.baselineCostUsd,
    currentCost: input.currentCost,
    newCost: {
      costSource: "reconciled",
      inputCostUsd: calculated.inputCostUsd,
      outputCostUsd: calculated.outputCostUsd,
      priceSource: input.price.source,
      priceVersion: input.price.priceVersion,
      totalCostUsd: calculated.totalCostUsd,
    },
    reconciliationSource: "price_data",
  });
}

function normalizeBillingReconciliationPayload(
  rawPayload: unknown,
): NormalizedBillingReconciliationPayload {
  const payload = readObject(rawPayload);
  const requestIds = Array.isArray(payload.requestIds)
    ? payload.requestIds
        .map(readStringArrayValue)
        .filter((value): value is string => Boolean(value))
    : [];
  const providerCosts = Array.isArray(payload.providerCosts) ? payload.providerCosts : [];
  const providerCostsByRequestId = new Map<string, BillingReconciliationProviderCost>();

  for (const rawCost of providerCosts) {
    const cost = normalizeProviderCost(rawCost);
    if (providerCostsByRequestId.has(cost.requestId)) {
      throw new JobHandlerError(
        "billing_reconciliation_invalid_payload",
        `Duplicate provider cost for request ${cost.requestId}.`,
      );
    }
    providerCostsByRequestId.set(cost.requestId, cost.providerCost);
    if (!requestIds.includes(cost.requestId)) {
      requestIds.push(cost.requestId);
    }
  }

  return {
    providerCostsByRequestId,
    requestIds,
  };
}

function normalizeProviderCost(rawValue: unknown): {
  providerCost: BillingReconciliationProviderCost;
  requestId: string;
} {
  const value = readObject(rawValue);
  const requestId = readRequiredString(value.requestId, "requestId");
  return {
    providerCost: {
      inputCostUsd: readOptionalNonNegativeNumber(value.inputCostUsd, "inputCostUsd"),
      outputCostUsd: readOptionalNonNegativeNumber(value.outputCostUsd, "outputCostUsd"),
      priceSource: readOptionalString(value.priceSource) ?? "provider_billing",
      priceVersion: readRequiredString(value.priceVersion, "priceVersion"),
      totalCostUsd: readRequiredNonNegativeNumber(value.totalCostUsd, "totalCostUsd"),
    },
    requestId,
  };
}

async function reconcileCandidateRequests(
  client: PostgresClient,
  input: {
    observedAt: Date;
    payload: NormalizedBillingReconciliationPayload;
  },
): Promise<BillingReconciliationCounts> {
  const candidates = await readReconciliationCandidates(client, input.payload.requestIds);
  const counts: BillingReconciliationCounts = {
    scannedRequestCount: candidates.length,
    skippedRequestCount: 0,
    updatedRequestCount: 0,
  };

  for (const candidate of candidates) {
    const update = buildBillingReconciliationUpdate({
      baselineCostUsd: parseNullableNumber(candidate.baseline_cost_usd),
      currentCost: {
        costSource: candidate.cost_source,
        inputCostUsd: parseNullableNumber(candidate.input_cost_usd),
        outputCostUsd: parseNullableNumber(candidate.output_cost_usd),
        priceSource: candidate.price_source,
        priceVersion: candidate.price_version,
        totalCostUsd: parseNullableNumber(candidate.total_cost_usd),
      },
      price: resolveEffectiveModelTokenPrice({
        manualOverride: rowToManualPriceOverride(candidate),
        modelId: candidate.model_id,
        providerKey: candidate.provider_key,
        syncedPrice: rowToSyncedPriceSnapshot(candidate),
      }),
      providerCost: input.payload.providerCostsByRequestId.get(candidate.request_id) ?? null,
      usage: {
        cachedInputTokens: candidate.cached_input_tokens,
        inputTokens: candidate.input_tokens,
        outputTokens: candidate.output_tokens,
      },
    });

    if (update.itemStatus === "updated") {
      counts.updatedRequestCount += 1;
      await updateReconciledCostAndSavings(client, {
        candidate,
        observedAt: input.observedAt,
        update,
      });
    } else {
      counts.skippedRequestCount += 1;
    }
  }

  return counts;
}

async function readReconciliationCandidates(
  client: PostgresClient,
  requestIds: string[],
): Promise<BillingReconciliationCandidateRow[]> {
  const result = await client.query<BillingReconciliationCandidateRow>(
    `
      select request_activity.id::text as activity_id,
             request_activity.request_id,
             providers.provider_key,
             provider_models.model_id,
             request_usage.input_tokens,
             request_usage.output_tokens,
             request_usage.cached_input_tokens,
             request_costs.id::text as request_cost_id,
             request_costs.input_cost_usd::text,
             request_costs.output_cost_usd::text,
             request_costs.total_cost_usd::text,
             request_costs.cost_source,
             request_costs.price_source,
             request_costs.price_version,
             request_costs.baseline_cost_usd::text,
             request_costs.savings_usd::text,
             provider_models.manual_input_usd_per_million_tokens::text
               as manual_input_usd_per_million_tokens,
             provider_models.manual_cached_input_usd_per_million_tokens::text
               as manual_cached_input_usd_per_million_tokens,
             provider_models.manual_output_usd_per_million_tokens::text
               as manual_output_usd_per_million_tokens,
             provider_models.manual_price_updated_at as manual_updated_at,
             provider_models.synced_input_usd_per_million_tokens::text
               as synced_input_usd_per_million_tokens,
             provider_models.synced_cached_input_usd_per_million_tokens::text
               as synced_cached_input_usd_per_million_tokens,
             provider_models.synced_output_usd_per_million_tokens::text
               as synced_output_usd_per_million_tokens,
             provider_models.synced_price_version
               as synced_price_version,
             provider_models.synced_price_source_url
               as synced_source_url,
             provider_models.synced_price_synced_at
               as synced_at
      from request_activity
      join request_usage on request_usage.request_activity_id = request_activity.id
      join request_costs on request_costs.request_activity_id = request_activity.id
      join provider_models on provider_models.id = request_usage.provider_model_id
      join providers on providers.id = provider_models.provider_id
      where request_activity.status = 'succeeded'
        and ($1::text[] is null or request_activity.request_id = any($1::text[]))
      order by request_activity.created_at, request_activity.id
      for update of request_costs
    `,
    [requestIds.length === 0 ? null : requestIds],
  );
  return result.rows;
}

async function updateReconciledCostAndSavings(
  client: PostgresClient,
  input: {
    candidate: BillingReconciliationCandidateRow;
    observedAt: Date;
    update: BillingReconciliationUpdate;
  },
): Promise<void> {
  await client.query(
    `
      update request_costs
      set input_cost_usd = $2,
          output_cost_usd = $3,
          total_cost_usd = $4,
          cost_source = $5,
          price_source = $6,
          price_version = $7,
          reconciled_at = $8::timestamptz,
          actual_cost_usd = $9,
          savings_usd = $10,
          savings_percent = $11,
          savings_price_source = $12,
          savings_price_version = $13
      where id = $1
    `,
    [
      input.candidate.request_cost_id,
      input.update.newCost.inputCostUsd,
      input.update.newCost.outputCostUsd,
      input.update.newCost.totalCostUsd,
      input.update.newCost.costSource,
      input.update.newCost.priceSource,
      input.update.newCost.priceVersion,
      input.observedAt.toISOString(),
      input.update.newSavings.actualCostUsd,
      input.update.newSavings.savingsUsd,
      input.update.newSavings.savingsPercent,
      input.update.newCost.priceSource,
      input.update.newCost.priceVersion,
    ],
  );
}

function buildUpdateResult(input: {
  baselineCostUsd: number | null;
  currentCost: BillingReconciliationCurrentCost;
  newCost: BillingReconciliationUpdate["newCost"];
  reconciliationSource: BillingReconciliationUpdate["reconciliationSource"];
}): BillingReconciliationUpdate {
  const newSavings = buildReconciledSavings(input.baselineCostUsd, input.newCost.totalCostUsd);
  return {
    itemStatus: costsAreEqual(input.currentCost, input.newCost) ? "skipped" : "updated",
    newCost: input.newCost,
    newSavings,
    reconciliationSource: input.reconciliationSource,
  };
}

function buildReconciledSavings(
  baselineCostUsd: number | null,
  actualCostUsd: number | null,
): BillingReconciliationUpdate["newSavings"] {
  if (baselineCostUsd === null || actualCostUsd === null) {
    return {
      actualCostUsd,
      savingsPercent: null,
      savingsUsd: null,
    };
  }

  const savingsUsd = roundUsd(baselineCostUsd - actualCostUsd);
  return {
    actualCostUsd,
    savingsPercent:
      baselineCostUsd === 0 ? null : roundPercent((savingsUsd / baselineCostUsd) * 100),
    savingsUsd,
  };
}

function costsAreEqual(
  currentCost: BillingReconciliationCurrentCost,
  newCost: BillingReconciliationUpdate["newCost"],
): boolean {
  return (
    currentCost.costSource === newCost.costSource &&
    currentCost.inputCostUsd === newCost.inputCostUsd &&
    currentCost.outputCostUsd === newCost.outputCostUsd &&
    currentCost.totalCostUsd === newCost.totalCostUsd &&
    currentCost.priceSource === newCost.priceSource &&
    currentCost.priceVersion === newCost.priceVersion
  );
}

function rowToManualPriceOverride(
  row: BillingReconciliationCandidateRow,
): ManualPriceOverride | null {
  if (
    row.manual_input_usd_per_million_tokens === null ||
    row.manual_output_usd_per_million_tokens === null ||
    row.manual_updated_at === null
  ) {
    return null;
  }

  return {
    cachedInputUsdPerMillionTokens:
      row.manual_cached_input_usd_per_million_tokens === null
        ? null
        : Number(row.manual_cached_input_usd_per_million_tokens),
    inputUsdPerMillionTokens: Number(row.manual_input_usd_per_million_tokens),
    modelId: row.model_id,
    outputUsdPerMillionTokens: Number(row.manual_output_usd_per_million_tokens),
    providerKey: row.provider_key,
    updatedAt: row.manual_updated_at,
  };
}

function rowToSyncedPriceSnapshot(
  row: BillingReconciliationCandidateRow,
): SyncedPriceSnapshot | null {
  if (
    row.synced_input_usd_per_million_tokens === null ||
    row.synced_output_usd_per_million_tokens === null ||
    row.synced_price_version === null ||
    row.synced_at === null
  ) {
    return null;
  }

  return {
    cachedInputUsdPerMillionTokens:
      row.synced_cached_input_usd_per_million_tokens === null
        ? null
        : Number(row.synced_cached_input_usd_per_million_tokens),
    inputUsdPerMillionTokens: Number(row.synced_input_usd_per_million_tokens),
    modelId: row.model_id,
    outputUsdPerMillionTokens: Number(row.synced_output_usd_per_million_tokens),
    priceVersion: row.synced_price_version,
    providerKey: row.provider_key,
    sourceUrl: row.synced_source_url,
    syncedAt: row.synced_at,
  };
}

function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readStringArrayValue(value: unknown): string | null {
  return readOptionalString(value);
}

function readRequiredString(value: unknown, fieldName: string): string {
  const normalized = readOptionalString(value);
  if (!normalized) {
    throw new JobHandlerError(
      "billing_reconciliation_invalid_payload",
      `Billing reconciliation payload ${fieldName} is required.`,
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
      "billing_reconciliation_invalid_payload",
      `Billing reconciliation payload ${fieldName} must be a non-negative number.`,
    );
  }
  return roundUsd(value);
}

function readOptionalNonNegativeNumber(value: unknown, fieldName: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return readRequiredNonNegativeNumber(value, fieldName);
}

function parseNullableNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function roundPercent(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundUsd(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}
