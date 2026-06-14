import { randomUUID } from "node:crypto";
import { Client } from "pg";

export type GatewayRequestActivityProtocol = "chat_completions" | "messages" | "responses";

export type GatewayRequestActivityRoute = {
  fallbackAttempts?: unknown[];
  providerId?: string;
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
            status = $7,
            error_code = $8,
            error_message = $9,
            http_status = $10,
            latency_ms = $11,
            completed_at = $12
        where id = $1
      `,
      [
        input.activityId,
        input.route?.routePolicyId ?? null,
        input.route?.providerId ?? null,
        input.route?.providerModelId ?? null,
        JSON.stringify(input.route?.routeReason ?? {}),
        JSON.stringify(input.route?.fallbackAttempts ?? []),
        completion.status,
        completion.errorCode,
        completion.errorMessage,
        completion.httpStatus,
        completion.latencyMs,
        completion.completedAt.toISOString(),
      ],
    );
  } finally {
    await client.end();
  }
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
