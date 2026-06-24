import { randomUUID } from "node:crypto";
import { calculateTokenCostUsd, type ModelTokenPrice } from "@llmingress/billing/price-registry";
import { PostgresClient } from "@llmingress/db/activity";
import type { GatewayRouteCandidateSnapshot, GatewayRoutePolicySnapshot } from "./config-reload.js";

export type GatewayUsageCostDetails = {
  actualPrice: ModelTokenPrice;
  baselinePrice: ModelTokenPrice;
  baselineProviderModelId: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  providerUsage?: GatewayProviderTokenUsage;
  providerModelId: string;
};

export type GatewayProviderTokenUsage = {
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
};

export type GatewayUsageCostRecords = {
  requestCost: {
    costSource: "estimated" | "unavailable";
    inputCostUsd: number | null;
    outputCostUsd: number | null;
    priceSource: string;
    priceVersion: string;
    totalCostUsd: number | null;
  };
  requestSavings: {
    actualCostUsd: number | null;
    baselineCostUsd: number | null;
    baselineProviderModelId: string;
    priceSource: string;
    priceVersion: string;
    savingsPercent: number | null;
    savingsUsd: number | null;
  };
  requestUsage: {
    cachedInputTokens: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    tokenSource: "estimated" | "provider";
    totalTokens: number;
  };
};

type RecordGatewayUsageCostInput = {
  activityId: string;
  agentApiKeyId: string;
  databaseUrl: string;
  usageCost: GatewayUsageCostDetails;
  virtualModelId: string;
};

export async function recordGatewayUsageCostAndSavings(
  input: RecordGatewayUsageCostInput,
): Promise<void> {
  const records = buildGatewayUsageCostRecords(input.usageCost);
  const client = new PostgresClient({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    await client.query("begin");
    await client.query(
      `
        insert into request_usage (
          id,
          request_activity_id,
          agent_id,
          virtual_model_id,
          provider_model_id,
          input_tokens,
          output_tokens,
          total_tokens,
          cached_input_tokens,
          reasoning_tokens,
          token_source
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        randomUUID(),
        input.activityId,
        input.agentApiKeyId,
        input.virtualModelId,
        input.usageCost.providerModelId,
        records.requestUsage.inputTokens,
        records.requestUsage.outputTokens,
        records.requestUsage.totalTokens,
        records.requestUsage.cachedInputTokens,
        records.requestUsage.reasoningTokens,
        records.requestUsage.tokenSource,
      ],
    );
    await client.query(
      `
        insert into request_costs (
          id,
          request_activity_id,
          agent_id,
          provider_model_id,
          input_cost_usd,
          output_cost_usd,
          total_cost_usd,
          cost_source,
          price_source,
          price_version,
          baseline_provider_model_id,
          actual_cost_usd,
          baseline_cost_usd,
          savings_usd,
          savings_percent,
          savings_price_source,
          savings_price_version
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      `,
      [
        randomUUID(),
        input.activityId,
        input.agentApiKeyId,
        input.usageCost.providerModelId,
        records.requestCost.inputCostUsd,
        records.requestCost.outputCostUsd,
        records.requestCost.totalCostUsd,
        records.requestCost.costSource,
        records.requestCost.priceSource,
        records.requestCost.priceVersion,
        records.requestSavings.baselineProviderModelId,
        records.requestSavings.actualCostUsd,
        records.requestSavings.baselineCostUsd,
        records.requestSavings.savingsUsd,
        records.requestSavings.savingsPercent,
        records.requestSavings.priceSource,
        records.requestSavings.priceVersion,
      ],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

export function buildGatewayUsageCostRecords(
  input: GatewayUsageCostDetails,
): GatewayUsageCostRecords {
  const usage = buildGatewayRequestUsage(input);
  const actualCost = calculateTokenCostUsd(input.actualPrice, {
    cachedInputTokens: usage.cachedInputTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });
  const baselineCost = calculateTokenCostUsd(input.baselinePrice, {
    cachedInputTokens: usage.cachedInputTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });

  if (actualCost.status !== "estimated") {
    return {
      requestCost: {
        costSource: "unavailable",
        inputCostUsd: null,
        outputCostUsd: null,
        priceSource: "unavailable",
        priceVersion: input.actualPrice.priceVersion,
        totalCostUsd: null,
      },
      requestSavings: {
        actualCostUsd: null,
        baselineCostUsd: null,
        baselineProviderModelId: input.baselineProviderModelId,
        priceSource: "unavailable",
        priceVersion: input.actualPrice.priceVersion,
        savingsPercent: null,
        savingsUsd: null,
      },
      requestUsage: usage,
    };
  }

  const priceSource =
    input.actualPrice.status === "priced" ? input.actualPrice.source : "unavailable";
  const requestCost = {
    costSource: "estimated" as const,
    inputCostUsd: actualCost.inputCostUsd,
    outputCostUsd: actualCost.outputCostUsd,
    priceSource,
    priceVersion: input.actualPrice.priceVersion,
    totalCostUsd: actualCost.totalCostUsd,
  };

  if (baselineCost.status !== "estimated") {
    return {
      requestCost,
      requestSavings: {
        actualCostUsd: actualCost.totalCostUsd,
        baselineCostUsd: null,
        baselineProviderModelId: input.baselineProviderModelId,
        priceSource: "unavailable",
        priceVersion: input.baselinePrice.priceVersion,
        savingsPercent: null,
        savingsUsd: null,
      },
      requestUsage: usage,
    };
  }

  const savingsUsd = roundUsd(baselineCost.totalCostUsd - actualCost.totalCostUsd);

  return {
    requestCost,
    requestSavings: {
      actualCostUsd: actualCost.totalCostUsd,
      baselineCostUsd: baselineCost.totalCostUsd,
      baselineProviderModelId: input.baselineProviderModelId,
      priceSource,
      priceVersion: input.actualPrice.priceVersion,
      savingsPercent:
        baselineCost.totalCostUsd === 0
          ? null
          : roundPercent((savingsUsd / baselineCost.totalCostUsd) * 100),
      savingsUsd,
    },
    requestUsage: usage,
  };
}

export function readGatewayProviderTokenUsage(
  body: unknown,
): GatewayProviderTokenUsage | undefined {
  if (!isRecord(body) || !isRecord(body.usage)) {
    return undefined;
  }

  const providerInputTokens =
    readNonNegativeInteger(body.usage.prompt_tokens) ??
    readNonNegativeInteger(body.usage.input_tokens);
  if (providerInputTokens === undefined) {
    return undefined;
  }

  const anthropicCacheCreationInputTokens =
    readNonNegativeInteger(body.usage.cache_creation_input_tokens) ?? 0;
  const anthropicCacheReadInputTokens =
    readNonNegativeInteger(body.usage.cache_read_input_tokens) ?? 0;
  const hasAnthropicCacheUsage =
    anthropicCacheCreationInputTokens > 0 || anthropicCacheReadInputTokens > 0;
  const inputTokens = hasAnthropicCacheUsage
    ? providerInputTokens + anthropicCacheCreationInputTokens + anthropicCacheReadInputTokens
    : providerInputTokens;
  const outputTokens =
    readNonNegativeInteger(body.usage.completion_tokens) ??
    readNonNegativeInteger(body.usage.output_tokens) ??
    0;
  const cachedInputTokens = Math.min(
    readNestedNonNegativeInteger(body.usage.prompt_tokens_details, "cached_tokens") ??
      readNestedNonNegativeInteger(body.usage.input_tokens_details, "cached_tokens") ??
      (hasAnthropicCacheUsage ? anthropicCacheReadInputTokens : undefined) ??
      readNonNegativeInteger(body.usage.cached_input_tokens) ??
      0,
    inputTokens,
  );
  const reasoningTokens =
    readNestedNonNegativeInteger(body.usage.completion_tokens_details, "reasoning_tokens") ??
    readNestedNonNegativeInteger(body.usage.output_tokens_details, "reasoning_tokens") ??
    readNonNegativeInteger(body.usage.reasoning_tokens) ??
    0;

  return {
    cachedInputTokens,
    inputTokens,
    outputTokens,
    reasoningTokens,
  };
}

export function selectGatewayBaselineCandidate(
  routePolicy: GatewayRoutePolicySnapshot,
): GatewayRouteCandidateSnapshot {
  const candidate = routePolicy.candidates
    .sort((left, right) => left.candidateOrder - right.candidateOrder)[0];
  if (!candidate) {
    throw new Error(`Route policy ${routePolicy.id} has no baseline candidate.`);
  }
  return candidate;
}

function buildGatewayRequestUsage(
  input: GatewayUsageCostDetails,
): GatewayUsageCostRecords["requestUsage"] {
  if (input.providerUsage) {
    return {
      cachedInputTokens: input.providerUsage.cachedInputTokens,
      inputTokens: input.providerUsage.inputTokens,
      outputTokens: input.providerUsage.outputTokens,
      reasoningTokens: input.providerUsage.reasoningTokens,
      tokenSource: "provider",
      totalTokens: input.providerUsage.inputTokens + input.providerUsage.outputTokens,
    };
  }

  return {
    cachedInputTokens: 0,
    inputTokens: input.estimatedInputTokens,
    outputTokens: input.estimatedOutputTokens,
    reasoningTokens: 0,
    tokenSource: "estimated",
    totalTokens: input.estimatedInputTokens + input.estimatedOutputTokens,
  };
}

function readNestedNonNegativeInteger(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return readNonNegativeInteger(value[key]);
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roundUsd(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function roundPercent(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
