import { randomUUID } from "node:crypto";
import { type PostgresQueryClient, withPostgresTransaction } from "@llmingress/db/client";
import { isRecord } from "@llmingress/util";
import type { FallbackFailedAttempt } from "./gateway-fallback-chain.ts";
import type { GatewayRequestMetadata } from "./gateway-request-metadata.ts";
import { readGatewayProviderTokenUsage } from "./gateway-usage-collector.ts";
import {
  type GatewayUsageCostDetails,
  insertGatewayUsageAndCost,
} from "./gateway-usage-recorder.ts";

export type GatewayRequestActivityProtocol =
  | "chat_completions"
  | "embeddings"
  | "messages"
  | "responses";

export type GatewayRequestActivityRoute = {
  fallbackAttempts?: unknown[];
  modelId?: string;
  providerApiKeyId?: string;
  providerApiKeyPrefix?: string;
  providerId?: string;
  providerKey?: string;
  providerModelId?: string;
  routePolicyId?: string;
  routeReason?: unknown;
};

export type GatewayActivityCompletion = {
  completedAt: Date;
  errorCode: string | null;
  errorMessage: string | null;
  httpStatus: number;
  latencyMs: number;
  status: "failed" | "succeeded";
};

export type GatewayResponseMetadata = {
  finishReason?: string;
  providerRequestId?: string;
  status: "failed" | "succeeded";
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
};

type RecordCompletedGatewayRequestActivityInput = {
  activityId: string;
  agentId: string;
  agentApiKeyPrefix: string;
  databaseUrl?: string;
  model: string;
  protocol: GatewayRequestActivityProtocol;
  completedAt?: Date;
  requestId: string;
  requestMetadata?: GatewayRequestMetadata;
  responseBody: unknown;
  route?: GatewayRequestActivityRoute;
  startedAt: Date;
  statusCode: number;
  stream: boolean;
  usageCost?: GatewayUsageCostDetails;
  virtualModelId: string;
};

export async function recordCompletedGatewayRequestActivity(
  input: RecordCompletedGatewayRequestActivityInput,
): Promise<void> {
  const completion = buildGatewayActivityCompletion({
    completedAt: input.completedAt ?? new Date(),
    responseBody: input.responseBody,
    startedAt: input.startedAt,
    statusCode: input.statusCode,
  });
  const loggingPolicy = {
    errorMessage: completion.errorMessage,
    requestMetadata: input.requestMetadata ?? {},
    responseMetadata: buildGatewayResponseMetadata({
      completion,
      responseBody: input.responseBody,
    }),
    route: input.route,
  };

  await withPostgresTransaction(input.databaseUrl, async (client) => {
    const safeRoute = await sanitizeGatewayRouteProviderApiKeys(client, loggingPolicy.route);
    const safeLoggingPolicy = {
      ...loggingPolicy,
      route: safeRoute,
    };

    await client.query(
      `
        insert into request_activity (
          id,
          request_id,
          agent_id,
          virtual_model_id,
          agent_key_prefix,
          protocol,
          model,
          stream,
          route_policy_id,
          provider_id,
          provider_model_id,
          route_reason,
          request_metadata,
          response_metadata,
          provider_api_key_id,
          provider_api_key_prefix,
          agent_name_snapshot,
          virtual_model_name_snapshot,
          route_policy_strategy_snapshot,
          provider_key_snapshot,
          provider_display_name_snapshot,
          provider_model_name_snapshot,
          provider_model_display_name_snapshot,
          status,
          error_code,
          error_message,
          http_status,
          latency_ms,
          started_at,
          completed_at,
          created_at
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
          $12::jsonb,
          $13::jsonb,
          $14::jsonb,
          $15,
          $16,
          (select name from agents where id = $3),
          (select name from virtual_models where id = $4),
          (select strategy::text from route_policies where id = $9),
          (select provider_key from providers where id = $10),
          (select display_name from providers where id = $10),
          (select model_id from provider_models where id = $11),
          (select display_name from provider_models where id = $11),
          $17,
          $18,
          $19,
          $20,
          $21,
          $22,
          $23,
          $22
        )
      `,
      [
        input.activityId,
        input.requestId,
        input.agentId,
        input.virtualModelId,
        input.agentApiKeyPrefix,
        input.protocol,
        input.model,
        input.stream,
        safeLoggingPolicy.route?.routePolicyId ?? null,
        safeLoggingPolicy.route?.providerId ?? null,
        safeLoggingPolicy.route?.providerModelId ?? null,
        JSON.stringify(safeLoggingPolicy.route?.routeReason ?? {}),
        JSON.stringify(safeLoggingPolicy.requestMetadata),
        JSON.stringify(safeLoggingPolicy.responseMetadata),
        safeLoggingPolicy.route?.providerApiKeyId ?? null,
        safeLoggingPolicy.route?.providerApiKeyPrefix ?? null,
        completion.status,
        completion.errorCode,
        safeLoggingPolicy.errorMessage,
        completion.httpStatus,
        completion.latencyMs,
        input.startedAt.toISOString(),
        completion.completedAt.toISOString(),
      ],
    );

    await insertFallbackEvents(client, {
      activityId: input.activityId,
      route: safeLoggingPolicy.route,
      succeeded: completion.status === "succeeded",
    });

    if (completion.status === "succeeded" && input.usageCost) {
      await insertGatewayUsageAndCost(client, {
        activityId: input.activityId,
        agentId: input.agentId,
        usageCost: input.usageCost,
        virtualModelId: input.virtualModelId,
      });
    }
  });
}

async function sanitizeGatewayRouteProviderApiKeys(
  client: PostgresQueryClient,
  route: GatewayRequestActivityRoute | undefined,
): Promise<GatewayRequestActivityRoute | undefined> {
  if (!route) {
    return undefined;
  }

  const keyIds = collectProviderApiKeyIds(route);
  if (keyIds.length === 0) {
    return route;
  }

  const existingKeyIds = new Set(
    (
      await client.query<{ id: string }>(
        `
          select id::text
          from provider_api_keys
          where id = any($1::uuid[])
        `,
        [keyIds],
      )
    ).rows.map((row) => row.id),
  );

  return {
    ...route,
    providerApiKeyId:
      route.providerApiKeyId && existingKeyIds.has(route.providerApiKeyId)
        ? route.providerApiKeyId
        : undefined,
    fallbackAttempts: readFallbackFailedAttempts(route).map((attempt) => ({
      ...attempt,
      providerApiKeyId:
        attempt.providerApiKeyId && existingKeyIds.has(attempt.providerApiKeyId)
          ? attempt.providerApiKeyId
          : undefined,
    })),
  };
}

function collectProviderApiKeyIds(route: GatewayRequestActivityRoute): string[] {
  const keyIds = new Set<string>();
  if (route.providerApiKeyId) {
    keyIds.add(route.providerApiKeyId);
  }
  for (const attempt of readFallbackFailedAttempts(route)) {
    if (attempt.providerApiKeyId) {
      keyIds.add(attempt.providerApiKeyId);
    }
  }
  return [...keyIds].sort();
}

function readFallbackFailedAttempts(route: GatewayRequestActivityRoute): FallbackFailedAttempt[] {
  return Array.isArray(route.fallbackAttempts)
    ? (route.fallbackAttempts as FallbackFailedAttempt[])
    : [];
}

async function insertFallbackEvents(
  client: PostgresQueryClient,
  input: {
    activityId: string;
    route?: GatewayRequestActivityRoute;
    succeeded: boolean;
  },
): Promise<void> {
  const failedAttempts = Array.isArray(input.route?.fallbackAttempts)
    ? (input.route.fallbackAttempts as FallbackFailedAttempt[])
    : [];

  for (const attempt of failedAttempts) {
    await client.query(
      `
        insert into fallback_events (
          id,
          request_activity_id,
          provider_model_id,
          provider_api_key_id,
          provider_api_key_prefix,
          attempt_order,
          status,
          error_code,
          error_message,
          failed_before_first_byte,
          retryable,
          status_code
        )
        values ($1, $2, $3, $4, $5, $6, 'failed', $7, $8, $9, $10, $11)
      `,
      [
        randomUUID(),
        input.activityId,
        attempt.providerModelId,
        attempt.providerApiKeyId || null,
        attempt.providerApiKeyPrefix || null,
        attempt.attemptOrder,
        attempt.errorCode,
        attempt.errorMessage,
        attempt.failedBeforeFirstByte,
        attempt.retryable,
        attempt.statusCode,
      ],
    );
  }

  if (!input.succeeded || !input.route?.providerModelId) {
    return;
  }

  const attemptOrder =
    failedAttempts.reduce((highest, attempt) => Math.max(highest, attempt.attemptOrder), 0) + 1;
  await client.query(
    `
      insert into fallback_events (
        id,
        request_activity_id,
        provider_model_id,
        provider_api_key_id,
        provider_api_key_prefix,
        attempt_order,
        status,
        failed_before_first_byte
      )
      values ($1, $2, $3, $4, $5, $6, 'succeeded', false)
    `,
    [
      randomUUID(),
      input.activityId,
      input.route.providerModelId,
      input.route.providerApiKeyId || null,
      input.route.providerApiKeyPrefix || null,
      attemptOrder,
    ],
  );
}

export function buildGatewayResponseMetadata(input: {
  completion: GatewayActivityCompletion;
  responseBody: unknown;
}): GatewayResponseMetadata {
  const metadata: GatewayResponseMetadata = {
    status: input.completion.status,
  };
  const providerRequestId = readNonEmptyStringProperty(input.responseBody, "id");
  if (providerRequestId) {
    metadata.providerRequestId = providerRequestId;
  } else {
    const responseId = readNonEmptyStringProperty(input.responseBody, "responseId");
    if (responseId) {
      metadata.providerRequestId = responseId;
    }
  }

  const finishReason = readGatewayFinishReason(input.responseBody);
  if (finishReason) {
    metadata.finishReason = finishReason;
  }

  const usage = readGatewayProviderTokenUsage(input.responseBody);
  if (usage) {
    metadata.tokenUsage = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
    };
  }

  return metadata;
}

export function buildGatewayActivityCompletion(input: {
  completedAt: Date;
  responseBody: unknown;
  startedAt: Date;
  statusCode: number;
}): GatewayActivityCompletion {
  const error = input.statusCode >= 400 ? readGatewayActivityError(input.responseBody) : null;

  return {
    completedAt: input.completedAt,
    errorCode: error?.errorCode ?? null,
    errorMessage: error?.errorMessage ?? null,
    httpStatus: input.statusCode,
    latencyMs: Math.max(0, input.completedAt.getTime() - input.startedAt.getTime()),
    status: input.statusCode >= 400 ? "failed" : "succeeded",
  };
}

export function readGatewayActivityError(
  responseBody: unknown,
): { errorCode: string; errorMessage: string | null } | null {
  if (!isRecord(responseBody) || !isRecord(responseBody.error)) {
    return null;
  }

  const errorCode = responseBody.error.code;
  if (typeof errorCode !== "string" || !errorCode.trim()) {
    return null;
  }
  const errorMessage = responseBody.error.message;

  return {
    errorCode,
    errorMessage: typeof errorMessage === "string" ? errorMessage : null,
  };
}

function readGatewayFinishReason(responseBody: unknown): string | undefined {
  if (!isRecord(responseBody)) {
    return undefined;
  }
  const direct =
    readNonEmptyStringProperty(responseBody, "finish_reason") ??
    readNonEmptyStringProperty(responseBody, "stop_reason");
  if (direct) {
    return direct;
  }
  if (Array.isArray(responseBody.choices)) {
    const firstChoice = responseBody.choices.find(isRecord);
    return readNonEmptyStringProperty(firstChoice, "finish_reason");
  }
  if (Array.isArray(responseBody.candidates)) {
    const firstCandidate = responseBody.candidates.find(isRecord);
    return readNonEmptyStringProperty(firstCandidate, "finishReason");
  }
  return undefined;
}

function readNonEmptyStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}
