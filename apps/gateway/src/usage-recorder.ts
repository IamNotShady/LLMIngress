import { randomUUID } from "node:crypto";
import { calculateTokenCostUsd, type ModelTokenPrice } from "@llmingress/billing/price-registry";
import { Client } from "pg";
import type { GatewayRouteCandidateSnapshot, GatewayRoutePolicySnapshot } from "./config-reload.js";

export type GatewayUsageCostDetails = {
  actualPrice: ModelTokenPrice;
  baselinePrice: ModelTokenPrice;
  baselineProviderModelId: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  providerModelId: string;
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
    inputTokens: number;
    outputTokens: number;
    tokenSource: "estimated";
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
  const client = new Client({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    await client.query("begin");
    await client.query(
      `
        insert into request_usage (
          id,
          request_activity_id,
          agent_api_key_id,
          virtual_model_id,
          provider_model_id,
          input_tokens,
          output_tokens,
          total_tokens,
          token_source
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
        records.requestUsage.tokenSource,
      ],
    );
    await client.query(
      `
        insert into request_costs (
          id,
          request_activity_id,
          agent_api_key_id,
          provider_model_id,
          input_cost_usd,
          output_cost_usd,
          total_cost_usd,
          cost_source,
          price_source,
          price_version
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
      ],
    );
    await client.query(
      `
        insert into request_savings (
          id,
          request_activity_id,
          baseline_provider_model_id,
          actual_cost_usd,
          baseline_cost_usd,
          savings_usd,
          savings_percent,
          price_source,
          price_version
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        randomUUID(),
        input.activityId,
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
  const usage = {
    inputTokens: input.estimatedInputTokens,
    outputTokens: input.estimatedOutputTokens,
    tokenSource: "estimated" as const,
    totalTokens: input.estimatedInputTokens + input.estimatedOutputTokens,
  };
  const actualCost = calculateTokenCostUsd(input.actualPrice, {
    inputTokens: input.estimatedInputTokens,
    outputTokens: input.estimatedOutputTokens,
  });
  const baselineCost = calculateTokenCostUsd(input.baselinePrice, {
    inputTokens: input.estimatedInputTokens,
    outputTokens: input.estimatedOutputTokens,
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

export function selectGatewayBaselineCandidate(
  routePolicy: GatewayRoutePolicySnapshot,
): GatewayRouteCandidateSnapshot {
  const candidate = routePolicy.candidates
    .filter((routeCandidate) => !routeCandidate.isFallback)
    .sort((left, right) => left.candidateOrder - right.candidateOrder)[0];
  if (!candidate) {
    throw new Error(`Route policy ${routePolicy.id} has no baseline candidate.`);
  }
  return candidate;
}

function roundUsd(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function roundPercent(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
