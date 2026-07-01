import { randomUUID } from "node:crypto";
import { PostgresClient } from "@llmingress/db/client";
import type { GatewayRequestMetadata } from "./gateway-request-metadata.ts";
import { readGatewayProviderTokenUsage } from "./gateway-usage-recorder.ts";

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

export type GatewayStartedRequestActivity = {
  id: string;
  startedAt: Date;
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

type CreateGatewayRequestActivityInput = {
  agentApiKeyId: string;
  agentApiKeyPrefix: string;
  databaseUrl?: string;
  model: string;
  protocol: GatewayRequestActivityProtocol;
  requestId: string;
  startedAt?: Date;
  stream: boolean;
  virtualModelId: string;
};

type CompleteGatewayRequestActivityInput = {
  activityId: string;
  completedAt?: Date;
  databaseUrl?: string;
  requestLoggingEnabled: boolean;
  requestMetadata?: GatewayRequestMetadata;
  responseBody: unknown;
  route?: GatewayRequestActivityRoute;
  startedAt: Date;
  statusCode: number;
};

export async function createGatewayRequestActivity(
  input: CreateGatewayRequestActivityInput,
): Promise<GatewayStartedRequestActivity> {
  const startedAt = input.startedAt ?? new Date();
  const id = randomUUID();
  const client = new PostgresClient({ connectionString: input.databaseUrl });
  await client.connect();

  try {
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
          agent_name_snapshot,
          virtual_model_name_snapshot,
          status,
          started_at,
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
          (select name from agents where id = $3),
          (select name from virtual_models where id = $4),
          'started',
          $9,
          $9
        )
      `,
      [
        id,
        input.requestId,
        input.agentApiKeyId,
        input.virtualModelId,
        input.agentApiKeyPrefix,
        input.protocol,
        input.model,
        input.stream,
        startedAt.toISOString(),
      ],
    );
  } finally {
    await client.end();
  }

  return { id, startedAt };
}

export async function completeGatewayRequestActivity(
  input: CompleteGatewayRequestActivityInput,
): Promise<void> {
  const completion = buildGatewayActivityCompletion({
    completedAt: input.completedAt ?? new Date(),
    responseBody: input.responseBody,
    startedAt: input.startedAt,
    statusCode: input.statusCode,
  });
  const loggingPolicy = applyGatewayRequestLoggingPolicy({
    completion,
    requestLoggingEnabled: input.requestLoggingEnabled,
    requestMetadata: input.requestMetadata,
    responseMetadata: buildGatewayResponseMetadata({
      completion,
      responseBody: input.responseBody,
    }),
    route: input.route,
  });
  const client = new PostgresClient({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    await client.query(
      `
        update request_activity
        set route_policy_id = $2,
            provider_id = $3,
            provider_model_id = $4,
            route_reason = $5::jsonb,
            fallback_attempts = $6::jsonb,
            request_metadata = $7::jsonb,
            response_metadata = $8::jsonb,
            provider_api_key_id = $9,
            provider_api_key_prefix = $10,
            route_policy_strategy_snapshot = (
              select strategy::text from route_policies where id = $2
            ),
            provider_key_snapshot = (
              select provider_key from providers where id = $3
            ),
            provider_display_name_snapshot = (
              select display_name from providers where id = $3
            ),
            provider_model_name_snapshot = (
              select model_id from provider_models where id = $4
            ),
            provider_model_display_name_snapshot = (
              select display_name from provider_models where id = $4
            ),
            status = $11,
            error_code = $12,
            error_message = $13,
            http_status = $14,
            latency_ms = $15,
            completed_at = $16
        where id = $1
      `,
      [
        input.activityId,
        loggingPolicy.route?.routePolicyId ?? null,
        loggingPolicy.route?.providerId ?? null,
        loggingPolicy.route?.providerModelId ?? null,
        JSON.stringify(loggingPolicy.route?.routeReason ?? {}),
        JSON.stringify(loggingPolicy.route?.fallbackAttempts ?? []),
        JSON.stringify(loggingPolicy.requestMetadata),
        JSON.stringify(loggingPolicy.responseMetadata),
        loggingPolicy.route?.providerApiKeyId ?? null,
        loggingPolicy.route?.providerApiKeyPrefix ?? null,
        completion.status,
        completion.errorCode,
        loggingPolicy.errorMessage,
        completion.httpStatus,
        completion.latencyMs,
        completion.completedAt.toISOString(),
      ],
    );
  } finally {
    await client.end();
  }
}

export function applyGatewayRequestLoggingPolicy(input: {
  completion: GatewayActivityCompletion;
  requestLoggingEnabled: boolean;
  requestMetadata?: GatewayRequestMetadata;
  responseMetadata: GatewayResponseMetadata;
  route?: GatewayRequestActivityRoute;
}): {
  errorMessage: string | null;
  requestMetadata: GatewayRequestMetadata | Record<string, never>;
  responseMetadata: GatewayResponseMetadata | Record<string, never>;
  route?: GatewayRequestActivityRoute;
} {
  if (input.requestLoggingEnabled) {
    return {
      errorMessage: input.completion.errorMessage,
      requestMetadata: input.requestMetadata ?? {},
      responseMetadata: input.responseMetadata,
      route: input.route,
    };
  }

  return {
    errorMessage: null,
    requestMetadata: {},
    route: input.route
      ? {
          modelId: input.route.modelId,
          providerApiKeyId: input.route.providerApiKeyId,
          providerApiKeyPrefix: input.route.providerApiKeyPrefix,
          providerId: input.route.providerId,
          providerKey: input.route.providerKey,
          providerModelId: input.route.providerModelId,
          routePolicyId: input.route.routePolicyId,
          fallbackAttempts: [],
          routeReason: {},
        }
      : undefined,
    responseMetadata: {},
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
