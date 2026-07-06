import { PostgresClient, type PostgresQueryResultRow } from "@llmingress/db/client";
import { formatConsoleUsd } from "@llmingress/db/console-format";

export type ConsoleActivity = {
  agentKeyPrefix: string | null;
  agentName: string | null;
  completedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  fallbackFailedAttemptCount: number;
  httpStatus: number | null;
  id: string;
  inputTokens: number | null;
  latencyMs: number | null;
  model: string | null;
  outputTokens: number | null;
  protocol: string;
  providerApiKeyId: string | null;
  providerApiKeyPrefix: string | null;
  providerDisplayName: string | null;
  providerKey: string | null;
  providerModelDisplayName: string | null;
  providerModelId: string | null;
  providerModelName: string | null;
  requestId: string;
  routePolicyStrategy: string | null;
  routeReason: unknown;
  startedAt: Date;
  status: string;
  totalCostUsd: string | null;
  totalTokens: number | null;
  virtualModelId: string | null;
  virtualModelDisplayName: string | null;
  virtualModelName: string | null;
};

export type ConsoleActivityFilters = {
  agentId?: string;
  from?: Date;
  protocol?: ConsoleActivityProtocol;
  providerId?: string;
  providerModelId?: string;
  requestId?: string;
  requestIdQuery?: string;
  status?: ConsoleActivityStatus;
  to?: Date;
  virtualModelId?: string;
};

export type ConsoleActivityListInput = {
  databaseUrl?: string;
  filters?: ConsoleActivityFiltersInput;
  limit?: number;
  page?: number;
};

export type ConsoleActivityFiltersInput = {
  agentId?: string | null;
  from?: Date | string | null;
  limit?: number | string | null;
  page?: number | string | null;
  protocol?: string | null;
  providerId?: string | null;
  providerModelId?: string | null;
  requestId?: string | null;
  requestIdQuery?: string | null;
  status?: string | null;
  to?: Date | string | null;
  virtualModelId?: string | null;
};

export type ConsoleFallbackEvent = {
  attemptOrder: number;
  createdAt: Date;
  errorCode: string | null;
  errorMessage: string | null;
  failedBeforeFirstByte: boolean;
  providerApiKeyId: string | null;
  providerApiKeyPrefix: string | null;
  providerModelDisplayName: string | null;
  providerModelId: string | null;
  providerModelName: string | null;
  retryable: boolean | null;
  status: string;
  statusCode: number | null;
};

export type ConsoleActivityDetail = {
  activity: ConsoleActivity;
  fallbackEvents: ConsoleFallbackEvent[];
  requestMetadata: unknown;
  responseMetadata: unknown;
};

type ConsoleActivityProtocol = "chat_completions" | "embeddings" | "messages" | "responses";
type ConsoleActivityStatus = "canceled" | "failed" | "started" | "succeeded";

type ActivityRow = PostgresQueryResultRow & {
  agent_key_prefix: string | null;
  agent_name: string | null;
  completed_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  fallback_failed_count: number;
  http_status: number | null;
  id: string;
  input_tokens: number | null;
  latency_ms: number | null;
  model: string | null;
  output_tokens: number | null;
  protocol: string;
  provider_api_key_id: string | null;
  provider_api_key_prefix: string | null;
  provider_display_name: string | null;
  provider_key: string | null;
  provider_model_display_name: string | null;
  provider_model_id: string | null;
  provider_model_name: string | null;
  request_id: string;
  request_metadata?: unknown;
  response_metadata?: unknown;
  route_policy_strategy: string | null;
  route_reason: unknown;
  started_at: Date;
  status: string;
  total_cost_usd: string | null;
  total_tokens: number | null;
  virtual_model_id: string | null;
  virtual_model_display_name: string | null;
  virtual_model_name: string | null;
};

type FallbackEventRow = PostgresQueryResultRow & {
  attempt_order: number;
  created_at: Date;
  error_code: string | null;
  error_message: string | null;
  failed_before_first_byte: boolean;
  provider_api_key_id: string | null;
  provider_api_key_prefix: string | null;
  provider_model_display_name: string | null;
  provider_model_id: string | null;
  provider_model_name: string | null;
  retryable: boolean | null;
  status: string;
  status_code: number | null;
};

type NormalizedActivityListInput = {
  databaseUrl?: string;
  filters: ConsoleActivityFilters;
  limit: number;
  page: number;
};

const activityStatuses = new Set<ConsoleActivityStatus>([
  "canceled",
  "failed",
  "started",
  "succeeded",
]);
const activityProtocols = new Set<ConsoleActivityProtocol>([
  "chat_completions",
  "embeddings",
  "messages",
  "responses",
]);

export async function listConsoleActivities(
  input: string | ConsoleActivityListInput = {},
  limit = 20,
): Promise<ConsoleActivity[]> {
  const listInput =
    typeof input === "string"
      ? normalizeActivityListInput({ databaseUrl: input, limit })
      : normalizeActivityListInput(input);
  const client = new PostgresClient({ connectionString: listInput.databaseUrl });
  await client.connect();

  try {
    const where = buildActivityWhereClause(listInput.filters);
    const result = await client.query<ActivityRow>(
      `
        select request_activity.id::text,
               request_activity.request_id,
               request_activity.protocol,
               request_activity.model,
               request_activity.status,
               request_activity.error_code,
               request_activity.error_message,
               request_activity.http_status,
               request_activity.latency_ms,
               request_activity.started_at,
               request_activity.completed_at,
               request_activity.route_reason,
               coalesce(fallback_counts.failed_count, 0)::integer as fallback_failed_count,
               coalesce(request_activity.route_policy_strategy_snapshot, route_policies.strategy::text)
                 as route_policy_strategy,
               request_activity.agent_key_prefix,
               coalesce(request_activity.agent_name_snapshot, agents.name) as agent_name,
               request_activity.provider_api_key_id::text as provider_api_key_id,
               request_activity.provider_api_key_prefix,
               coalesce(
                 request_activity.provider_display_name_snapshot,
                 providers.display_name
               ) as provider_display_name,
               coalesce(request_activity.provider_key_snapshot, providers.provider_key)
                 as provider_key,
               request_activity.provider_model_id::text as provider_model_id,
               coalesce(
                 request_activity.provider_model_display_name_snapshot,
                 provider_models.display_name
               ) as provider_model_display_name,
               coalesce(request_activity.provider_model_name_snapshot, provider_models.model_id)
                 as provider_model_name,
               request_activity.virtual_model_id::text as virtual_model_id,
               coalesce(virtual_models.description, request_activity.virtual_model_name_snapshot)
                 as virtual_model_display_name,
               coalesce(request_activity.virtual_model_name_snapshot, virtual_models.name)
                 as virtual_model_name,
               request_usage.input_tokens,
               request_usage.output_tokens,
               request_usage.total_tokens,
               request_costs.total_cost_usd::text
        from request_activity
        left join agents on agents.id = request_activity.agent_id
        left join virtual_models on virtual_models.id = request_activity.virtual_model_id
        left join route_policies on route_policies.id = request_activity.route_policy_id
        left join providers on providers.id = request_activity.provider_id
        left join provider_models on provider_models.id = request_activity.provider_model_id
        left join request_usage on request_usage.request_activity_id = request_activity.id
        left join request_costs on request_costs.request_activity_id = request_activity.id
        left join lateral (
          select count(*)::integer as failed_count
          from fallback_events
          where fallback_events.request_activity_id = request_activity.id
            and fallback_events.status = 'failed'
        ) fallback_counts on true
        ${where.sql}
        order by request_activity.started_at desc,
                 request_activity.created_at desc
        limit $${where.values.length + 1}
        offset $${where.values.length + 2}
      `,
      [...where.values, listInput.limit, (listInput.page - 1) * listInput.limit],
    );

    return result.rows.map(rowToConsoleActivity);
  } finally {
    await client.end();
  }
}

export async function countConsoleActivities(input: {
  databaseUrl?: string;
  filters?: ConsoleActivityFiltersInput;
}): Promise<number> {
  const {
    limit: _filterLimit,
    page: _filterPage,
    ...filters
  } = normalizeConsoleActivityFilters(input.filters ?? {});
  const client = new PostgresClient({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    const where = buildActivityWhereClause(filters);
    const result = await client.query<PostgresQueryResultRow & { count: string }>(
      `
        select count(*)::text as count
        from request_activity
        ${where.sql}
      `,
      where.values,
    );
    return Number.parseInt(result.rows[0]?.count ?? "0", 10);
  } finally {
    await client.end();
  }
}

export async function getConsoleActivityDetail(input: {
  activityId?: string;
  databaseUrl?: string;
  requestId?: string;
}): Promise<ConsoleActivityDetail | null> {
  if (!input.activityId && !input.requestId) {
    throw new Error("Activity detail requires activityId or requestId.");
  }

  const client = new PostgresClient({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    const result = await client.query<ActivityRow>(
      `
        select request_activity.id::text,
               request_activity.request_id,
               request_activity.protocol,
               request_activity.model,
               request_activity.status,
               request_activity.error_code,
               request_activity.error_message,
               request_activity.http_status,
               request_activity.latency_ms,
               request_activity.started_at,
               request_activity.completed_at,
               request_activity.route_reason,
               coalesce(fallback_counts.failed_count, 0)::integer as fallback_failed_count,
               request_activity.request_metadata,
               request_activity.response_metadata,
               coalesce(request_activity.route_policy_strategy_snapshot, route_policies.strategy::text)
                 as route_policy_strategy,
               request_activity.agent_key_prefix,
               coalesce(request_activity.agent_name_snapshot, agents.name) as agent_name,
               request_activity.provider_api_key_id::text as provider_api_key_id,
               request_activity.provider_api_key_prefix,
               coalesce(
                 request_activity.provider_display_name_snapshot,
                 providers.display_name
               ) as provider_display_name,
               coalesce(request_activity.provider_key_snapshot, providers.provider_key)
                 as provider_key,
               request_activity.provider_model_id::text as provider_model_id,
               coalesce(
                 request_activity.provider_model_display_name_snapshot,
                 provider_models.display_name
               ) as provider_model_display_name,
               coalesce(request_activity.provider_model_name_snapshot, provider_models.model_id)
                 as provider_model_name,
               request_activity.virtual_model_id::text as virtual_model_id,
               coalesce(virtual_models.description, request_activity.virtual_model_name_snapshot)
                 as virtual_model_display_name,
               coalesce(request_activity.virtual_model_name_snapshot, virtual_models.name)
                 as virtual_model_name,
               request_usage.input_tokens,
               request_usage.output_tokens,
               request_usage.total_tokens,
               request_costs.total_cost_usd::text
        from request_activity
        left join agents on agents.id = request_activity.agent_id
        left join virtual_models on virtual_models.id = request_activity.virtual_model_id
        left join route_policies on route_policies.id = request_activity.route_policy_id
        left join providers on providers.id = request_activity.provider_id
        left join provider_models on provider_models.id = request_activity.provider_model_id
        left join request_usage on request_usage.request_activity_id = request_activity.id
        left join request_costs on request_costs.request_activity_id = request_activity.id
        left join lateral (
          select count(*)::integer as failed_count
          from fallback_events
          where fallback_events.request_activity_id = request_activity.id
            and fallback_events.status = 'failed'
        ) fallback_counts on true
        where ($1::uuid is null or request_activity.id = $1)
          and ($2::text is null or request_activity.request_id = $2)
        limit 1
      `,
      [input.activityId ?? null, input.requestId ?? null],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    const fallbackEvents = await client.query<FallbackEventRow>(
      `
        select fallback_events.attempt_order,
               fallback_events.status,
               fallback_events.error_code,
               fallback_events.error_message,
               fallback_events.failed_before_first_byte,
               fallback_events.provider_api_key_id::text as provider_api_key_id,
               fallback_events.provider_api_key_prefix,
               fallback_events.provider_model_id::text as provider_model_id,
               provider_models.display_name as provider_model_display_name,
               provider_models.model_id as provider_model_name,
               fallback_events.retryable,
               fallback_events.status_code,
               fallback_events.created_at
        from fallback_events
        left join provider_models on provider_models.id = fallback_events.provider_model_id
        where fallback_events.request_activity_id = $1
        order by fallback_events.attempt_order asc
      `,
      [row.id],
    );

    return {
      activity: rowToConsoleActivity(row),
      fallbackEvents: fallbackEvents.rows.map(rowToConsoleFallbackEvent),
      requestMetadata: row.request_metadata ?? {},
      responseMetadata: row.response_metadata ?? {},
    };
  } finally {
    await client.end();
  }
}

export function normalizeConsoleActivityFilters(
  input: ConsoleActivityFiltersInput = {},
): ConsoleActivityFilters & { limit?: number; page?: number } {
  const status = readEnum(input.status, activityStatuses);
  const protocol = readEnum(input.protocol, activityProtocols);

  return {
    agentId: readTrimmed(input.agentId),
    from: readDate(input.from),
    limit: normalizeLimit(input.limit),
    page: normalizePage(input.page),
    protocol,
    providerId: readTrimmed(input.providerId),
    providerModelId: readTrimmed(input.providerModelId),
    requestId: readTrimmed(input.requestId),
    requestIdQuery: readTrimmed(input.requestIdQuery),
    status,
    to: readDate(input.to),
    virtualModelId: readTrimmed(input.virtualModelId),
  };
}

function normalizeActivityListInput(input: ConsoleActivityListInput): NormalizedActivityListInput {
  const {
    limit: _filterLimit,
    page: _filterPage,
    ...filters
  } = normalizeConsoleActivityFilters(input.filters ?? {});
  return {
    databaseUrl: input.databaseUrl,
    filters,
    limit: normalizeLimit(input.limit),
    page: normalizePage(input.page),
  };
}

function buildActivityWhereClause(filters: ConsoleActivityFilters): {
  sql: string;
  values: unknown[];
} {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    clauses.push(sql.replace("?", `$${values.length}`));
  };

  if (filters.status) {
    add("request_activity.status = ?", filters.status);
  }
  if (filters.protocol) {
    add("request_activity.protocol = ?", filters.protocol);
  }
  if (filters.providerId) {
    add("request_activity.provider_id = ?::uuid", filters.providerId);
  }
  if (filters.providerModelId) {
    add("request_activity.provider_model_id = ?::uuid", filters.providerModelId);
  }
  if (filters.virtualModelId) {
    add("request_activity.virtual_model_id = ?::uuid", filters.virtualModelId);
  }
  if (filters.agentId) {
    add("request_activity.agent_id = ?::uuid", filters.agentId);
  }
  if (filters.requestId) {
    add("request_activity.request_id = ?", filters.requestId);
  }
  if (filters.requestIdQuery) {
    add("request_activity.request_id ilike ?", `%${escapeLike(filters.requestIdQuery)}%`);
  }
  if (filters.from) {
    add("request_activity.started_at >= ?", filters.from);
  }
  if (filters.to) {
    add("request_activity.started_at <= ?", filters.to);
  }

  return {
    sql: clauses.length > 0 ? `where ${clauses.join(" and ")}` : "",
    values,
  };
}

export function formatConsoleActivityCost(totalCostUsd: string | null): string {
  return formatConsoleUsd(totalCostUsd);
}

export function formatConsoleActivityTokens(input: {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}): string {
  if (input.inputTokens === null || input.outputTokens === null || input.totalTokens === null) {
    return "Token usage unavailable";
  }

  return `${input.totalTokens} total tokens (${input.inputTokens} input, ${input.outputTokens} output)`;
}

export function formatConsoleActivityRouteReason(routeReason: unknown): string {
  if (isRecord(routeReason) && typeof routeReason.message === "string") {
    const message = routeReason.message.trim();
    if (message) {
      return message;
    }
  }

  return "No route reason recorded";
}

export function formatConsoleActivityFallbackAttempts(
  fallbackEvents: readonly ConsoleFallbackEvent[],
): string[] {
  const failedEvents = fallbackEvents.filter((event) => event.status === "failed");
  if (failedEvents.length === 0) {
    return ["No fallback attempts"];
  }

  return failedEvents.map((event, index) => {
    const attemptOrder = Number.isFinite(event.attemptOrder) ? event.attemptOrder : index + 1;
    const errorCode = event.errorCode?.trim() || "unknown_error";
    const providerModelId = event.providerModelId?.trim() || "unknown provider model";
    const firstByte = event.failedBeforeFirstByte ? " before first byte" : "";

    return `Attempt ${attemptOrder}: ${errorCode}${firstByte} on ${providerModelId}`;
  });
}

export function formatConsoleActivityMetadata(metadata: unknown): string[] {
  const lines: string[] = [];
  collectMetadataLines("", metadata, lines);
  return lines.length > 0 ? lines.sort() : ["No request metadata recorded"];
}

function rowToConsoleActivity(row: ActivityRow): ConsoleActivity {
  return {
    agentKeyPrefix: row.agent_key_prefix,
    agentName: row.agent_name,
    completedAt: row.completed_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    fallbackFailedAttemptCount: Number(row.fallback_failed_count),
    httpStatus: row.http_status,
    id: row.id,
    inputTokens: row.input_tokens,
    latencyMs: row.latency_ms,
    model: row.model,
    outputTokens: row.output_tokens,
    protocol: row.protocol,
    providerApiKeyId: row.provider_api_key_id,
    providerApiKeyPrefix: row.provider_api_key_prefix,
    providerDisplayName: row.provider_display_name,
    providerKey: row.provider_key,
    providerModelDisplayName: row.provider_model_display_name,
    providerModelId: row.provider_model_id,
    providerModelName: row.provider_model_name,
    requestId: row.request_id,
    routePolicyStrategy: row.route_policy_strategy,
    routeReason: row.route_reason,
    startedAt: row.started_at,
    status: row.status,
    totalCostUsd: row.total_cost_usd,
    totalTokens: row.total_tokens,
    virtualModelId: row.virtual_model_id,
    virtualModelDisplayName: row.virtual_model_display_name,
    virtualModelName: row.virtual_model_name,
  };
}

function rowToConsoleFallbackEvent(row: FallbackEventRow): ConsoleFallbackEvent {
  return {
    attemptOrder: row.attempt_order,
    createdAt: row.created_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    failedBeforeFirstByte: row.failed_before_first_byte,
    providerApiKeyId: row.provider_api_key_id,
    providerApiKeyPrefix: row.provider_api_key_prefix,
    providerModelDisplayName: row.provider_model_display_name,
    providerModelId: row.provider_model_id,
    providerModelName: row.provider_model_name,
    retryable: row.retryable,
    status: row.status,
    statusCode: row.status_code,
  };
}

function readTrimmed(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readDate(value: Date | string | null | undefined): Date | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function readEnum<T extends string>(
  value: string | null | undefined,
  allowed: Set<T>,
): T | undefined {
  const trimmed = readTrimmed(value);
  return trimmed && allowed.has(trimmed as T) ? (trimmed as T) : undefined;
}

function normalizeLimit(value: number | string | null | undefined): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    return 20;
  }
  return Math.min(100, Math.max(1, Math.trunc(parsed)));
}

function normalizePage(value: number | string | null | undefined): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    return 1;
  }
  return Math.max(1, Math.trunc(parsed));
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

const hiddenMetadataKeys = new Set([
  "apiKey",
  "content",
  "encryptedKey",
  "plaintext",
  "prompt",
  "promptPreview",
  "promptText",
  "response",
  "responsePreview",
  "responseText",
  "secret",
  "text",
]);

function collectMetadataLines(prefix: string, value: unknown, lines: string[]): void {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (prefix) {
      lines.push(`${prefix}: ${String(value)}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (prefix) {
      lines.push(`${prefix}: [${value.length} items]`);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (hiddenMetadataKeys.has(key)) {
      continue;
    }
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    collectMetadataLines(nextPrefix, child, lines);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
