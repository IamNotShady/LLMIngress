import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { GatewayRequestMetadata } from "./request-metadata.js";

export type GatewayRequestActivityProtocol =
  | "chat_completions"
  | "embeddings"
  | "messages"
  | "responses";

export type GatewayRequestActivityRoute = {
  fallbackAttempts?: unknown[];
  modelId?: string;
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

type CreateGatewayRequestActivityInput = {
  agentApiKeyId: string;
  agentApiKeyPrefix: string;
  databaseUrl: string;
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
  databaseUrl: string;
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
  const client = new Client({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    await client.query(
      `
        insert into request_activity (
          id,
          request_id,
          agent_api_key_id,
          virtual_model_id,
          agent_api_key_prefix,
          protocol,
          model,
          stream,
          status,
          started_at,
          created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, 'started', $9, $9)
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
    route: input.route,
  });
  const client = new Client({ connectionString: input.databaseUrl });
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
            status = $8,
            error_code = $9,
            error_message = $10,
            http_status = $11,
            latency_ms = $12,
            completed_at = $13
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
  route?: GatewayRequestActivityRoute;
}): {
  errorMessage: string | null;
  requestMetadata: GatewayRequestMetadata | Record<string, never>;
  route?: GatewayRequestActivityRoute;
} {
  if (input.requestLoggingEnabled) {
    return {
      errorMessage: input.completion.errorMessage,
      requestMetadata: input.requestMetadata ?? {},
      route: input.route,
    };
  }

  return {
    errorMessage: null,
    requestMetadata: {},
    route: input.route
      ? {
          modelId: input.route.modelId,
          providerId: input.route.providerId,
          providerKey: input.route.providerKey,
          providerModelId: input.route.providerModelId,
          routePolicyId: input.route.routePolicyId,
          fallbackAttempts: [],
          routeReason: {},
        }
      : undefined,
  };
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
