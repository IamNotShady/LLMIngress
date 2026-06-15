import { randomUUID } from "node:crypto";
import {
  calculateTokenCostUsd,
  type ManualPriceOverride,
  type ModelTokenPrice,
  resolveEffectiveModelTokenPrice,
  type SyncedPriceSnapshot,
} from "@llmingress/billing/price-registry";
import { Client, type QueryResultRow } from "pg";
import { type JobHandler, JobHandlerError } from "./job-runner.js";

export type BillingReconciliationJobHandlerOptions = {
  databaseUrl: string;
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

type BillingReconciliationCandidateRow = QueryResultRow & {
  activity_id: string;
  baseline_cost_usd: string | null;
  cached_input_tokens: number;
  cost_source: string;
  input_cost_usd: string | null;
  input_tokens: number;
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
  request_savings_id: string | null;
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
    const runId = randomUUID();
    const client = new Client({ connectionString: options.databaseUrl });
    await client.connect();

    try {
      await client.query("begin");
      await insertReconciliationRun(client, {
        jobId: job.id,
        runId,
        startedAt: observedAt,
        trigger: job.trigger,
      });

      const counts = await reconcileCandidateRequests(client, {
        observedAt,
        payload,
        runId,
      });
      await completeReconciliationRun(client, {
        completedAt: observedAt,
        counts,
        runId,
      });
      await client.query("commit");

      return {
        runId,
        ...counts,
      };
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
  client: Client,
  input: {
    observedAt: Date;
    payload: NormalizedBillingReconciliationPayload;
    runId: string;
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
    await insertReconciliationItem(client, {
      candidate,
      runId: input.runId,
      update,
    });
  }

  return counts;
}

async function readReconciliationCandidates(
  client: Client,
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
             request_savings.id::text as request_savings_id,
             request_savings.baseline_cost_usd::text,
             request_savings.savings_usd::text,
             model_price_overrides.input_usd_per_million_tokens::text
               as manual_input_usd_per_million_tokens,
             model_price_overrides.output_usd_per_million_tokens::text
               as manual_output_usd_per_million_tokens,
             model_price_overrides.updated_at as manual_updated_at,
             latest_price_registry_snapshot.input_usd_per_million_tokens::text
               as synced_input_usd_per_million_tokens,
             latest_price_registry_snapshot.cached_input_usd_per_million_tokens::text
               as synced_cached_input_usd_per_million_tokens,
             latest_price_registry_snapshot.output_usd_per_million_tokens::text
               as synced_output_usd_per_million_tokens,
             latest_price_registry_snapshot.price_version
               as synced_price_version,
             latest_price_registry_snapshot.source_url
               as synced_source_url,
             latest_price_registry_snapshot.snapshot_at
               as synced_at
      from request_activity
      join request_usage on request_usage.request_activity_id = request_activity.id
      join request_costs on request_costs.request_activity_id = request_activity.id
      left join request_savings on request_savings.request_activity_id = request_activity.id
      join provider_models on provider_models.id = request_usage.provider_model_id
      join providers on providers.id = provider_models.provider_id
      left join model_price_overrides
        on lower(model_price_overrides.provider_key) = lower(providers.provider_key)
       and model_price_overrides.model_id = provider_models.model_id
      left join lateral (
        select input_usd_per_million_tokens,
               cached_input_usd_per_million_tokens,
               output_usd_per_million_tokens,
               price_version,
               source_url,
               snapshot_at
        from price_registry_snapshots
        where lower(price_registry_snapshots.provider_key) = lower(providers.provider_key)
          and price_registry_snapshots.model_id = provider_models.model_id
        order by snapshot_at desc, created_at desc
        limit 1
      ) latest_price_registry_snapshot on true
      where request_activity.status = 'succeeded'
        and ($1::text[] is null or request_activity.request_id = any($1::text[]))
      order by request_activity.created_at, request_activity.id
      for update of request_costs
    `,
    [requestIds.length === 0 ? null : requestIds],
  );
  return result.rows;
}

async function insertReconciliationRun(
  client: Client,
  input: { jobId: string; runId: string; startedAt: Date; trigger: string },
): Promise<void> {
  await client.query(
    `
      insert into billing_reconciliation_runs (
        id,
        job_id,
        trigger,
        status,
        started_at
      )
      values ($1, $2, $3, 'running', $4::timestamptz)
    `,
    [input.runId, input.jobId, input.trigger, input.startedAt.toISOString()],
  );
}

async function completeReconciliationRun(
  client: Client,
  input: {
    completedAt: Date;
    counts: BillingReconciliationCounts;
    runId: string;
  },
): Promise<void> {
  await client.query(
    `
      update billing_reconciliation_runs
      set status = 'succeeded',
          scanned_request_count = $2,
          updated_request_count = $3,
          skipped_request_count = $4,
          completed_at = $5::timestamptz,
          updated_at = $5::timestamptz
      where id = $1
    `,
    [
      input.runId,
      input.counts.scannedRequestCount,
      input.counts.updatedRequestCount,
      input.counts.skippedRequestCount,
      input.completedAt.toISOString(),
    ],
  );
}

async function updateReconciledCostAndSavings(
  client: Client,
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
          reconciled_at = $8::timestamptz
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
    ],
  );

  if (!input.candidate.request_savings_id) {
    return;
  }

  await client.query(
    `
      update request_savings
      set actual_cost_usd = $2,
          savings_usd = $3,
          savings_percent = $4,
          price_source = $5,
          price_version = $6
      where id = $1
    `,
    [
      input.candidate.request_savings_id,
      input.update.newSavings.actualCostUsd,
      input.update.newSavings.savingsUsd,
      input.update.newSavings.savingsPercent,
      input.update.newCost.priceSource,
      input.update.newCost.priceVersion,
    ],
  );
}

async function insertReconciliationItem(
  client: Client,
  input: {
    candidate: BillingReconciliationCandidateRow;
    runId: string;
    update: BillingReconciliationUpdate;
  },
): Promise<void> {
  await client.query(
    `
      insert into billing_reconciliation_items (
        id,
        run_id,
        request_activity_id,
        request_cost_id,
        request_savings_id,
        reconciliation_source,
        status,
        previous_cost_source,
        new_cost_source,
        previous_total_cost_usd,
        new_total_cost_usd,
        previous_price_source,
        new_price_source,
        previous_price_version,
        new_price_version,
        previous_savings_usd,
        new_savings_usd,
        metadata
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
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        $17,
        $18::jsonb
      )
    `,
    [
      randomUUID(),
      input.runId,
      input.candidate.activity_id,
      input.candidate.request_cost_id,
      input.candidate.request_savings_id,
      input.update.reconciliationSource,
      input.update.itemStatus,
      input.candidate.cost_source,
      input.update.newCost.costSource,
      parseNullableNumber(input.candidate.total_cost_usd),
      input.update.newCost.totalCostUsd,
      input.candidate.price_source,
      input.update.newCost.priceSource,
      input.candidate.price_version,
      input.update.newCost.priceVersion,
      parseNullableNumber(input.candidate.savings_usd),
      input.update.newSavings.savingsUsd,
      JSON.stringify(input.update.skipReason ? { skipReason: input.update.skipReason } : {}),
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
