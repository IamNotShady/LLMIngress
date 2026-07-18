import { randomUUID } from "node:crypto";
import { calculateTokenCostUsd, type ModelTokenPrice } from "@llmingress/billing/price-registry";
import type { PostgresQueryClient } from "@llmingress/db/client";
import type { GatewayProviderTokenUsage } from "./gateway-usage-collector.ts";

export type GatewayUsageCostDetails = {
  actualPrice: ModelTokenPrice;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  providerUsage?: GatewayProviderTokenUsage;
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
  apiKeyId: string;
  usageCost: GatewayUsageCostDetails;
  virtualModelId: string;
};

export async function insertGatewayUsageAndCost(
  client: PostgresQueryClient,
  input: RecordGatewayUsageCostInput,
): Promise<void> {
  const records = buildGatewayUsageCostRecords(input.usageCost);

  await client.query(
    `
        insert into request_usage (
          id,
          request_activity_id,
          api_key_id,
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
      input.apiKeyId,
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
          api_key_id,
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
      input.apiKeyId,
      input.usageCost.providerModelId,
      records.requestCost.inputCostUsd,
      records.requestCost.outputCostUsd,
      records.requestCost.totalCostUsd,
      records.requestCost.costSource,
      records.requestCost.priceSource,
      records.requestCost.priceVersion,
    ],
  );
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
  if (actualCost.status !== "estimated") {
    return {
      requestCost: {
        costSource: "unavailable",
        inputCostUsd: 0,
        outputCostUsd: 0,
        priceSource: "unavailable",
        priceVersion: input.actualPrice.priceVersion,
        totalCostUsd: 0,
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

  return {
    requestCost,
    requestUsage: usage,
  };
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
