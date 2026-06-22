import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PostgresClient, type PostgresQueryResultRow } from "@llmingress/db/maintenance";
import { type JobHandler, JobHandlerError } from "./job-runner.js";

export type JsonlRequestLogExportJobHandlerOptions = {
  databaseUrl: string;
  now?: () => Date;
};

export type JsonlRequestLogActivityRow = PostgresQueryResultRow & {
  agent_id: string;
  agent_key_prefix: string;
  agent_name: string;
  agent_type: string;
  completed_at: Date | null;
  created_at: Date;
  error_code: string | null;
  error_message: string | null;
  fallback_attempts: unknown;
  http_status: number | null;
  id: string;
  latency_ms: number | null;
  model: string | null;
  protocol: string;
  provider_display_name: string | null;
  provider_id: string | null;
  provider_key: string | null;
  provider_model_display_name: string | null;
  provider_model_id: string | null;
  provider_model_model_id: string | null;
  request_id: string;
  route_policy_id: string | null;
  route_reason: unknown;
  started_at: Date;
  status: string;
  stream: boolean;
  virtual_model_id: string | null;
  virtual_model_name: string | null;
};

export type JsonlRequestLogUsageRow = PostgresQueryResultRow & {
  cached_input_tokens: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  token_source: string;
  total_tokens: number;
};

export type JsonlRequestLogCostRow = PostgresQueryResultRow & {
  cost_source: string;
  input_cost_usd: string | null;
  output_cost_usd: string | null;
  price_source: string | null;
  price_version: string | null;
  total_cost_usd: string | null;
};

export type JsonlRequestLogFallbackEventRow = PostgresQueryResultRow & {
  attempt_order: number;
  created_at: Date;
  error_code: string | null;
  error_message: string | null;
  failed_before_first_byte: boolean;
  provider_key: string | null;
  provider_model_id: string | null;
  provider_model_model_id: string | null;
  request_activity_id?: string;
  status: string;
};

export type JsonlRequestLogRecordInput = {
  activity: JsonlRequestLogActivityRow;
  cost: JsonlRequestLogCostRow | null;
  fallbackEvents: JsonlRequestLogFallbackEventRow[];
  usage: JsonlRequestLogUsageRow | null;
};

type NormalizedJsonlExportPayload = {
  from: Date | null;
  limit: number;
  outputPath: string;
  requestIds: string[];
  to: Date | null;
};

const exportType = "jsonl_request_logs";
const defaultLimit = 10_000;
const maxLimit = 100_000;

export function createJsonlRequestLogExportJobHandler(
  options: JsonlRequestLogExportJobHandlerOptions,
): JobHandler {
  const now = options.now ?? (() => new Date());

  return async (job) => {
    const startedAt = now();
    const payload = normalizeJsonlExportPayload(job.payload);
    const client = new PostgresClient({ connectionString: options.databaseUrl });
    await client.connect();

    try {
      const rows = await readRequestLogRows(client, payload);
      const activityIds = rows.map((row) => row.activity.id);
      const fallbackEventsByActivityId = await readFallbackEventsByActivityId(client, activityIds);
      const records = rows.map((row) =>
        buildJsonlRequestLogRecord({
          ...row,
          fallbackEvents: fallbackEventsByActivityId.get(row.activity.id) ?? [],
        }),
      );
      await writeJsonlFile(payload.outputPath, records);

      const completedAt = now();

      return {
        completedAt: completedAt.toISOString(),
        exportType,
        lineCount: records.length,
        outputPath: payload.outputPath,
        startedAt: startedAt.toISOString(),
        trigger: job.trigger,
      };
    } finally {
      await client.end();
    }
  };
}

export function buildJsonlRequestLogRecord(input: JsonlRequestLogRecordInput) {
  const activity = input.activity;

  return {
    agent: {
      id: activity.agent_id,
      keyPrefix: activity.agent_key_prefix,
      name: activity.agent_name,
      type: activity.agent_type,
    },
    completedAt: toIsoString(activity.completed_at),
    cost: input.cost
      ? {
          costSource: input.cost.cost_source,
          inputCostUsd: readNullableDecimal(input.cost.input_cost_usd),
          outputCostUsd: readNullableDecimal(input.cost.output_cost_usd),
          priceSource: input.cost.price_source,
          priceVersion: input.cost.price_version,
          totalCostUsd: readNullableDecimal(input.cost.total_cost_usd),
        }
      : null,
    createdAt: activity.created_at.toISOString(),
    error:
      activity.error_code || activity.error_message
        ? {
            code: activity.error_code,
            httpStatus: activity.http_status,
            message: redactSecretString(activity.error_message),
          }
        : null,
    fallbackAttempts: redactSecretsFromJsonlValue(activity.fallback_attempts),
    fallbackEvents: input.fallbackEvents.map((event) => ({
      attemptOrder: event.attempt_order,
      createdAt: event.created_at.toISOString(),
      errorCode: event.error_code,
      errorMessage: redactSecretString(event.error_message),
      failedBeforeFirstByte: event.failed_before_first_byte,
      providerKey: event.provider_key,
      providerModelId: event.provider_model_id,
      providerModelModelId: event.provider_model_model_id,
      status: event.status,
    })),
    latencyMs: activity.latency_ms,
    model: activity.model,
    protocol: activity.protocol,
    provider:
      activity.provider_id || activity.provider_key || activity.provider_display_name
        ? {
            displayName: activity.provider_display_name,
            id: activity.provider_id,
            key: activity.provider_key,
          }
        : null,
    providerModel:
      activity.provider_model_id ||
      activity.provider_model_model_id ||
      activity.provider_model_display_name
        ? {
            displayName: activity.provider_model_display_name,
            id: activity.provider_model_id,
            modelId: activity.provider_model_model_id,
          }
        : null,
    requestActivityId: activity.id,
    requestId: activity.request_id,
    routePolicyId: activity.route_policy_id,
    routeReason: redactSecretsFromJsonlValue(activity.route_reason),
    startedAt: activity.started_at.toISOString(),
    status: activity.status,
    stream: activity.stream,
    usage: input.usage
      ? {
          cachedInputTokens: input.usage.cached_input_tokens,
          inputTokens: input.usage.input_tokens,
          outputTokens: input.usage.output_tokens,
          reasoningTokens: input.usage.reasoning_tokens,
          tokenSource: input.usage.token_source,
          totalTokens: input.usage.total_tokens,
        }
      : null,
    virtualModel: activity.virtual_model_id
      ? {
          id: activity.virtual_model_id,
          name: activity.virtual_model_name,
        }
      : null,
  };
}

export function redactSecretsFromJsonlValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecretsFromJsonlValue(entry));
  }

  if (!value || typeof value !== "object") {
    return typeof value === "string" ? redactSecretString(value) : value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    output[key] = isSensitiveJsonKey(key) ? "[REDACTED]" : redactSecretsFromJsonlValue(nestedValue);
  }
  return output;
}

function normalizeJsonlExportPayload(rawPayload: unknown): NormalizedJsonlExportPayload {
  const payload = readObject(rawPayload);
  const outputPath = readRequiredString(payload.outputPath, "outputPath");
  const requestIds = Array.isArray(payload.requestIds)
    ? payload.requestIds.map((requestId) => readRequiredString(requestId, "requestIds[]"))
    : [];
  const from = readOptionalDate(payload.from, "from");
  const to = readOptionalDate(payload.to, "to");
  const limit = readOptionalPositiveInteger(payload.limit, defaultLimit);

  if (limit > maxLimit) {
    throw new JobHandlerError(
      "jsonl_export_invalid_payload",
      `JSONL export limit must be ${maxLimit} or lower.`,
    );
  }

  return {
    from,
    limit,
    outputPath: resolve(outputPath),
    requestIds,
    to,
  };
}

async function readRequestLogRows(
  client: PostgresClient,
  payload: NormalizedJsonlExportPayload,
): Promise<
  Array<{
    activity: JsonlRequestLogActivityRow;
    cost: JsonlRequestLogCostRow | null;
    usage: JsonlRequestLogUsageRow | null;
  }>
> {
  const values: unknown[] = [];
  const conditions: string[] = [];

  if (payload.requestIds.length > 0) {
    values.push(payload.requestIds);
    conditions.push(`request_activity.request_id = any($${values.length}::text[])`);
  }
  if (payload.from) {
    values.push(payload.from.toISOString());
    conditions.push(`request_activity.created_at >= $${values.length}::timestamptz`);
  }
  if (payload.to) {
    values.push(payload.to.toISOString());
    conditions.push(`request_activity.created_at < $${values.length}::timestamptz`);
  }
  values.push(payload.limit);

  const result = await client.query<
    JsonlRequestLogActivityRow & Partial<JsonlRequestLogUsageRow & JsonlRequestLogCostRow>
  >(
    `
      select
        request_activity.id::text,
        request_activity.request_id,
        request_activity.agent_id::text as agent_id,
        request_activity.agent_key_prefix as agent_key_prefix,
        request_activity.protocol,
        request_activity.model,
        request_activity.stream,
        request_activity.route_reason,
        request_activity.fallback_attempts,
        request_activity.status,
        request_activity.error_code,
        request_activity.error_message,
        request_activity.http_status,
        request_activity.latency_ms,
        request_activity.started_at,
        request_activity.completed_at,
        request_activity.created_at,
        agents.id::text as agent_id,
        coalesce(request_activity.agent_name_snapshot, agents.name) as agent_name,
        agents.agent_type,
        virtual_models.id::text as virtual_model_id,
        coalesce(request_activity.virtual_model_name_snapshot, virtual_models.name)
          as virtual_model_name,
        route_policies.id::text as route_policy_id,
        providers.id::text as provider_id,
        coalesce(request_activity.provider_key_snapshot, providers.provider_key)
          as provider_key,
        coalesce(
          request_activity.provider_display_name_snapshot,
          providers.display_name
        ) as provider_display_name,
        provider_models.id::text as provider_model_id,
        coalesce(request_activity.provider_model_name_snapshot, provider_models.model_id)
          as provider_model_model_id,
        coalesce(
          request_activity.provider_model_display_name_snapshot,
          provider_models.display_name
        ) as provider_model_display_name,
        request_usage.input_tokens,
        request_usage.output_tokens,
        request_usage.total_tokens,
        request_usage.cached_input_tokens,
        request_usage.reasoning_tokens,
        request_usage.token_source,
        request_costs.input_cost_usd,
        request_costs.output_cost_usd,
        request_costs.total_cost_usd,
        request_costs.cost_source,
        request_costs.price_source,
        request_costs.price_version
      from request_activity
      join agents on agents.id = request_activity.agent_id
      left join virtual_models on virtual_models.id = request_activity.virtual_model_id
      left join route_policies on route_policies.id = request_activity.route_policy_id
      left join providers on providers.id = request_activity.provider_id
      left join provider_models on provider_models.id = request_activity.provider_model_id
      left join request_usage on request_usage.request_activity_id = request_activity.id
      left join request_costs on request_costs.request_activity_id = request_activity.id
      ${conditions.length > 0 ? `where ${conditions.join(" and ")}` : ""}
      order by request_activity.created_at, request_activity.request_id
      limit $${values.length}::integer
    `,
    values,
  );

  return result.rows.map((row) => ({
    activity: row,
    cost:
      row.cost_source != null
        ? {
            cost_source: row.cost_source as string,
            input_cost_usd: row.input_cost_usd ?? null,
            output_cost_usd: row.output_cost_usd ?? null,
            price_source: row.price_source ?? null,
            price_version: row.price_version ?? null,
            total_cost_usd: row.total_cost_usd ?? null,
          }
        : null,
    usage:
      row.token_source != null
        ? {
            cached_input_tokens: row.cached_input_tokens ?? 0,
            input_tokens: row.input_tokens ?? 0,
            output_tokens: row.output_tokens ?? 0,
            reasoning_tokens: row.reasoning_tokens ?? 0,
            token_source: row.token_source as string,
            total_tokens: row.total_tokens ?? 0,
          }
        : null,
  }));
}

async function readFallbackEventsByActivityId(
  client: PostgresClient,
  activityIds: string[],
): Promise<Map<string, JsonlRequestLogFallbackEventRow[]>> {
  const eventsByActivityId = new Map<string, JsonlRequestLogFallbackEventRow[]>();
  if (activityIds.length === 0) {
    return eventsByActivityId;
  }

  const result = await client.query<
    JsonlRequestLogFallbackEventRow & { request_activity_id: string }
  >(
    `
      select
        fallback_events.request_activity_id::text,
        fallback_events.attempt_order,
        fallback_events.status,
        fallback_events.error_code,
        fallback_events.error_message,
        fallback_events.failed_before_first_byte,
        fallback_events.created_at,
        provider_models.id::text as provider_model_id,
        provider_models.model_id as provider_model_model_id,
        providers.provider_key
      from fallback_events
      left join provider_models on provider_models.id = fallback_events.provider_model_id
      left join providers on providers.id = provider_models.provider_id
      where fallback_events.request_activity_id = any($1::uuid[])
      order by fallback_events.request_activity_id, fallback_events.attempt_order
    `,
    [activityIds],
  );

  for (const event of result.rows) {
    const events = eventsByActivityId.get(event.request_activity_id) ?? [];
    events.push(event);
    eventsByActivityId.set(event.request_activity_id, events);
  }

  return eventsByActivityId;
}

async function writeJsonlFile(outputPath: string, records: unknown[]): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const jsonl = records.map((record) => JSON.stringify(record)).join("\n");
  await writeFile(outputPath, jsonl ? `${jsonl}\n` : "", "utf8");
}

function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new JobHandlerError(
      "jsonl_export_invalid_payload",
      `JSONL export payload ${fieldName} is required.`,
    );
  }
  return value.trim();
}

function readOptionalDate(value: unknown, fieldName: string): Date | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new JobHandlerError(
      "jsonl_export_invalid_payload",
      `JSONL export payload ${fieldName} must be an ISO timestamp.`,
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new JobHandlerError(
      "jsonl_export_invalid_payload",
      `JSONL export payload ${fieldName} must be an ISO timestamp.`,
    );
  }
  return date;
}

function readOptionalPositiveInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new JobHandlerError(
      "jsonl_export_invalid_payload",
      "JSONL export payload limit must be a positive integer.",
    );
  }
  return value;
}

function readNullableDecimal(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return Number(value);
}

function redactSecretString(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  return value
    .replace(/Bearer\s+sk-[A-Za-z0-9._-]+/g, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9._-]+/g, "[REDACTED]")
    .replace(/sha256:v1:[A-Za-z0-9._:-]+/g, "[REDACTED]")
    .replace(/ciphertext-[A-Za-z0-9._-]+/g, "[REDACTED]");
}

function isSensitiveJsonKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[-_\s]/g, "");
  if (normalized.includes("prefix") || normalized === "providerkey") {
    return false;
  }

  return (
    normalized.includes("authorization") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("token") ||
    normalized.includes("encrypted") ||
    normalized.includes("ciphertext") ||
    normalized.includes("keyhash") ||
    normalized.includes("apikey") ||
    normalized === "key"
  );
}

function toIsoString(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}
