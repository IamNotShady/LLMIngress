import { withPooledPostgresClient } from "@llmingress/db/client";
import { isRecord } from "@llmingress/util";
import { consoleValidationError } from "./console-operation-error.ts";

export type ConsoleActivity = {
  apiKeyPrefix: string | null;
  apiKeyName: string | null;
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
  virtualModelName: string | null;
};

export type ConsoleActivityFilters = {
  apiKeyId?: string;
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
  apiKeyId?: string | null;
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

/**
 * A candidate the route policy weighed, and what became of it. The gateway
 * records one of these per candidate — including the ones it filtered out and
 * why — and without them the timeline says what happened but never what else
 * could have.
 */
export type ConsoleActivityRouteCandidate = {
  candidateOrder: number;
  eligible: boolean;
  /** The provider and model, resolved for reading; the id when it is gone. */
  label: string;
  providerModelId: string;
  reasons: string[];
};

export type ConsoleActivityDetail = {
  activity: ConsoleActivity;
  fallbackEvents: ConsoleFallbackEvent[];
  requestMetadata: unknown;
  responseMetadata: unknown;
  routeCandidates: ConsoleActivityRouteCandidate[];
};

type ConsoleActivityProtocol = "chat_completions" | "messages" | "responses";
type ConsoleActivityStatus = "canceled" | "failed" | "started" | "succeeded";

type ActivityRow = {
  api_key_prefix: string | null;
  api_key_name: string | null;
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
  virtual_model_name: string | null;
};

type FallbackEventRow = {
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
  return withPooledPostgresClient(listInput.databaseUrl, async (client) => {
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
               request_activity.api_key_prefix,
               coalesce(request_activity.api_key_name_snapshot, api_keys.name) as api_key_name,
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
               coalesce(request_activity.virtual_model_name_snapshot, virtual_models.name)
                 as virtual_model_name,
               request_usage.input_tokens,
               request_usage.output_tokens,
               request_usage.total_tokens,
               request_costs.total_cost_usd::text
        from request_activity
        left join api_keys on api_keys.id = request_activity.api_key_id
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
  });
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
  return withPooledPostgresClient(input.databaseUrl, async (client) => {
    const where = buildActivityWhereClause(filters);
    const result = await client.query<{ count: string }>(
      `
        select count(*)::text as count
        from request_activity
        ${where.sql}
      `,
      where.values,
    );
    return Number.parseInt(result.rows[0]?.count ?? "0", 10);
  });
}

export async function getConsoleActivityDetail(input: {
  activityId?: string;
  databaseUrl?: string;
  requestId?: string;
}): Promise<ConsoleActivityDetail | null> {
  if (!input.activityId && !input.requestId) {
    throw consoleValidationError(
      "Activity detail requires activityId or requestId.",
      "activity_detail_key_required",
    );
  }

  return withPooledPostgresClient(input.databaseUrl, async (client) => {
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
               request_activity.api_key_prefix,
               coalesce(request_activity.api_key_name_snapshot, api_keys.name) as api_key_name,
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
               coalesce(request_activity.virtual_model_name_snapshot, virtual_models.name)
                 as virtual_model_name,
               request_usage.input_tokens,
               request_usage.output_tokens,
               request_usage.total_tokens,
               request_costs.total_cost_usd::text
        from request_activity
        left join api_keys on api_keys.id = request_activity.api_key_id
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

    // The recorded explanations carry ids; what an operator can read is the
    // provider and model they name, so they are resolved here in one query
    // rather than rendered as uuids.
    const recorded = readConsoleActivityRouteCandidates(row.route_reason);
    const labels = new Map<string, string>();
    if (recorded.length > 0) {
      const named = await client.query<{
        display_name: string | null;
        id: string;
        model_id: string;
        provider_display_name: string | null;
      }>(
        `
          select provider_models.id::text as id,
                 provider_models.model_id,
                 provider_models.display_name,
                 providers.display_name as provider_display_name
          from provider_models
          left join providers on providers.id = provider_models.provider_id
          where provider_models.id = any($1::uuid[])
        `,
        [recorded.map((candidate) => candidate.providerModelId)],
      );
      for (const model of named.rows) {
        const name = model.display_name ?? model.model_id;
        labels.set(
          model.id,
          model.provider_display_name ? `${model.provider_display_name} · ${name}` : name,
        );
      }
    }

    return {
      activity: rowToConsoleActivity(row),
      fallbackEvents: fallbackEvents.rows.map(rowToConsoleFallbackEvent),
      requestMetadata: row.request_metadata ?? {},
      responseMetadata: row.response_metadata ?? {},
      routeCandidates: recorded.map((candidate) => ({
        ...candidate,
        label: labels.get(candidate.providerModelId) ?? "model no longer in the catalog",
      })),
    };
  });
}

export function normalizeConsoleActivityFilters(
  input: ConsoleActivityFiltersInput = {},
): ConsoleActivityFilters & { limit?: number; page?: number } {
  const status = readEnum(input.status, activityStatuses);
  const protocol = readEnum(input.protocol, activityProtocols);

  return {
    apiKeyId: readTrimmed(input.apiKeyId),
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
  if (filters.apiKeyId) {
    add("request_activity.api_key_id = ?::uuid", filters.apiKeyId);
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

/**
 * The candidate explanations as recorded, without the names: reading them is
 * separable from resolving what each id is called, and a request whose route
 * predates this field simply has none.
 */
export function readConsoleActivityRouteCandidates(
  routeReason: unknown,
): Array<Omit<ConsoleActivityRouteCandidate, "label">> {
  if (!isRecord(routeReason) || !Array.isArray(routeReason.candidateExplanations)) {
    return [];
  }
  return routeReason.candidateExplanations
    .filter(isRecord)
    .filter((entry) => typeof entry.providerModelId === "string" && entry.providerModelId)
    .map((entry, index) => ({
      candidateOrder:
        typeof entry.candidateOrder === "number" && Number.isFinite(entry.candidateOrder)
          ? entry.candidateOrder
          : index + 1,
      eligible: entry.eligible !== false,
      providerModelId: String(entry.providerModelId),
      reasons: Array.isArray(entry.reasons)
        ? entry.reasons.filter((reason): reason is string => typeof reason === "string" && !!reason)
        : [],
    }))
    .sort((left, right) => left.candidateOrder - right.candidateOrder);
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

export function formatConsoleActivityMetadata(metadata: unknown): string[] {
  const lines: string[] = [];
  collectMetadataLines("", metadata, lines);
  return lines.length > 0 ? lines.sort() : ["No request metadata recorded"];
}

function rowToConsoleActivity(row: ActivityRow): ConsoleActivity {
  return {
    apiKeyPrefix: row.api_key_prefix,
    apiKeyName: row.api_key_name,
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
