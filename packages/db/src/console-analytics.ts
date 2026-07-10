import { PostgresClient } from "@llmingress/db/client";
import { consoleValidationError } from "./console-operation-error.ts";

export type ConsoleAnalyticsBucket = "day" | "hour";

export type ConsoleAnalyticsFilters = {
  agentId?: string;
  providerId?: string;
  virtualModelId?: string;
};

export type ConsoleAnalyticsInput = {
  bucket?: string | null;
  end: Date | string | null | undefined;
  filters?: ConsoleAnalyticsFiltersInput;
  start: Date | string | null | undefined;
  topLimit?: number | string | null;
};

export type ConsoleAnalyticsFiltersInput = {
  agentId?: string | null;
  providerId?: string | null;
  virtualModelId?: string | null;
};

export type NormalizedConsoleAnalyticsInput = {
  bucket: ConsoleAnalyticsBucket;
  end: Date;
  filters: ConsoleAnalyticsFilters;
  previousEnd: Date;
  previousStart: Date;
  start: Date;
  topLimit: number;
};

export type ConsoleAnalyticsKpis = {
  failureCount: number;
  failureRate: number;
  fallbackEventCount: number;
  fallbackRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  p95LatencyMs: number | null;
  requestCount: number;
  totalCostUsd: string | null;
  totalSavingsUsd: string | null;
  totalTokens: number;
};

export type ConsoleAnalyticsTopItem = ConsoleAnalyticsKpis & {
  id: string;
  label: string;
};

export type ConsoleAnalyticsRouteMetric = ConsoleAnalyticsTopItem & {
  failedFallbackEventCount: number;
  succeededFallbackEventCount: number;
};

export type ConsoleAnalyticsTimeseriesPoint = ConsoleAnalyticsKpis & {
  bucketStart: Date;
};

export type ConsoleAnalyticsSnapshot = {
  current: ConsoleAnalyticsKpis;
  previous: ConsoleAnalyticsKpis;
  routeMetrics: ConsoleAnalyticsRouteMetric[];
  timeseries: ConsoleAnalyticsTimeseriesPoint[];
  topAgents: ConsoleAnalyticsTopItem[];
  topProviderModels: ConsoleAnalyticsTopItem[];
  topRoutes: ConsoleAnalyticsTopItem[];
  topVirtualModels: ConsoleAnalyticsTopItem[];
  window: NormalizedConsoleAnalyticsInput;
};

type AnalyticsQueryInput = NormalizedConsoleAnalyticsInput & {
  databaseUrl?: string;
};

type AnalyticsRange = {
  end: Date;
  start: Date;
};

type AnalyticsKpiRow = {
  failure_count: number;
  failure_rate: number | string | null;
  fallback_event_count: number | string | null;
  fallback_request_count: number;
  input_tokens: string | null;
  output_tokens: string | null;
  p95_latency_ms: number | string | null;
  request_count: number;
  total_cost_usd: string | null;
  total_savings_usd: string | null;
  total_tokens: string | null;
};

type AnalyticsTopRow = AnalyticsKpiRow & {
  id: string | null;
  label: string | null;
};

type AnalyticsRouteMetricRow = AnalyticsTopRow & {
  failed_fallback_event_count: number | string | null;
  succeeded_fallback_event_count: number | string | null;
};

type AnalyticsTimeseriesRow = AnalyticsKpiRow & {
  bucket_start: Date;
};

const analyticsBuckets = new Set<ConsoleAnalyticsBucket>(["day", "hour"]);

export function normalizeConsoleAnalyticsInput(
  input: ConsoleAnalyticsInput,
): NormalizedConsoleAnalyticsInput {
  const start = readDate(input.start);
  const end = readDate(input.end);
  if (!start || !end) {
    throw consoleValidationError(
      "Analytics start and end dates are required.",
      "analytics_dates_required",
    );
  }
  if (end.getTime() <= start.getTime()) {
    throw consoleValidationError(
      "Analytics end date must be after start date.",
      "analytics_date_range_invalid",
    );
  }

  const durationMs = end.getTime() - start.getTime();
  const bucket = readBucket(input.bucket) ?? (durationMs <= 48 * 60 * 60 * 1000 ? "hour" : "day");
  return {
    bucket,
    end,
    filters: {
      agentId: readTrimmed(input.filters?.agentId),
      providerId: readTrimmed(input.filters?.providerId),
      virtualModelId: readTrimmed(input.filters?.virtualModelId),
    },
    previousEnd: start,
    previousStart: new Date(start.getTime() - durationMs),
    start,
    topLimit: normalizeTopLimit(input.topLimit),
  };
}

export async function getConsoleAnalyticsSnapshot(
  input: ConsoleAnalyticsInput & { databaseUrl?: string },
): Promise<ConsoleAnalyticsSnapshot> {
  const normalized = normalizeConsoleAnalyticsInput(input);
  const queryInput = { ...normalized, databaseUrl: input.databaseUrl };
  const client = new PostgresClient({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    const current = await queryKpis(client, queryInput, {
      end: normalized.end,
      start: normalized.start,
    });
    const previous = await queryKpis(client, queryInput, {
      end: normalized.previousEnd,
      start: normalized.previousStart,
    });
    const timeseries = await queryTimeseries(client, queryInput);
    const topAgents = await queryTopItems(client, queryInput, topAgentSql);
    const topProviderModels = await queryTopItems(client, queryInput, topProviderModelSql);
    const topVirtualModels = await queryTopItems(client, queryInput, topVirtualModelSql);
    const topRoutes = await queryTopItems(client, queryInput, topRouteSql);
    const routeMetrics = await queryRouteMetrics(client, queryInput);

    return {
      current,
      previous,
      routeMetrics,
      timeseries,
      topAgents,
      topProviderModels,
      topRoutes,
      topVirtualModels,
      window: normalized,
    };
  } finally {
    await client.end();
  }
}

async function queryKpis(
  client: PostgresClient,
  input: AnalyticsQueryInput,
  range: AnalyticsRange,
): Promise<ConsoleAnalyticsKpis> {
  const scoped = buildScopedActivityCte(input, range);
  const result = await client.query<AnalyticsKpiRow>(
    `
      with ${scoped.sql},
           fallback_counts as (${fallbackCountsSql})
      select ${analyticsMetricSelectSql}
      from scoped_activity
      left join request_usage on request_usage.request_activity_id = scoped_activity.id
      left join request_costs on request_costs.request_activity_id = scoped_activity.id
      left join fallback_counts on fallback_counts.request_activity_id = scoped_activity.id
    `,
    scoped.values,
  );

  return rowToAnalyticsKpis(result.rows[0]);
}

async function queryTimeseries(
  client: PostgresClient,
  input: AnalyticsQueryInput,
): Promise<ConsoleAnalyticsTimeseriesPoint[]> {
  const scoped = buildScopedActivityCte(input, { end: input.end, start: input.start });
  const bucket = input.bucket === "hour" ? "hour" : "day";
  const result = await client.query<AnalyticsTimeseriesRow>(
    `
      with ${scoped.sql},
           fallback_counts as (${fallbackCountsSql})
      select date_trunc('${bucket}', scoped_activity.started_at) as bucket_start,
             ${analyticsMetricSelectSql}
      from scoped_activity
      left join request_usage on request_usage.request_activity_id = scoped_activity.id
      left join request_costs on request_costs.request_activity_id = scoped_activity.id
      left join fallback_counts on fallback_counts.request_activity_id = scoped_activity.id
      group by bucket_start
      order by bucket_start asc
    `,
    scoped.values,
  );

  return result.rows.map((row) => ({
    ...rowToAnalyticsKpis(row),
    bucketStart: row.bucket_start,
  }));
}

async function queryTopItems(
  client: PostgresClient,
  input: AnalyticsQueryInput,
  dimension: { id: string; label: string },
): Promise<ConsoleAnalyticsTopItem[]> {
  const scoped = buildScopedActivityCte(input, { end: input.end, start: input.start });
  const values = [...scoped.values, input.topLimit];
  const result = await client.query<AnalyticsTopRow>(
    `
      with ${scoped.sql},
           fallback_counts as (${fallbackCountsSql})
      select ${dimension.id} as id,
             ${dimension.label} as label,
             ${analyticsMetricSelectSql}
      from scoped_activity
      left join request_usage on request_usage.request_activity_id = scoped_activity.id
      left join request_costs on request_costs.request_activity_id = scoped_activity.id
      left join fallback_counts on fallback_counts.request_activity_id = scoped_activity.id
      group by ${dimension.id}, ${dimension.label}
      order by count(scoped_activity.id) desc,
               coalesce(sum(request_costs.total_cost_usd), 0) desc,
               label asc
      limit $${values.length}
    `,
    values,
  );

  return result.rows.map(rowToAnalyticsTopItem);
}

async function queryRouteMetrics(
  client: PostgresClient,
  input: AnalyticsQueryInput,
): Promise<ConsoleAnalyticsRouteMetric[]> {
  const scoped = buildScopedActivityCte(input, { end: input.end, start: input.start });
  const values = [...scoped.values, input.topLimit];
  const result = await client.query<AnalyticsRouteMetricRow>(
    `
      with ${scoped.sql},
           fallback_counts as (${fallbackCountsSql})
      select ${topRouteSql.id} as id,
             ${topRouteSql.label} as label,
             ${analyticsMetricSelectSql},
             coalesce(sum(fallback_counts.failed_fallback_event_count), 0)::integer
               as failed_fallback_event_count,
             coalesce(sum(fallback_counts.succeeded_fallback_event_count), 0)::integer
               as succeeded_fallback_event_count
      from scoped_activity
      left join request_usage on request_usage.request_activity_id = scoped_activity.id
      left join request_costs on request_costs.request_activity_id = scoped_activity.id
      left join fallback_counts on fallback_counts.request_activity_id = scoped_activity.id
      group by ${topRouteSql.id}, ${topRouteSql.label}
      order by count(scoped_activity.id) desc,
               coalesce(sum(fallback_counts.fallback_event_count), 0) desc,
               label asc
      limit $${values.length}
    `,
    values,
  );

  return result.rows.map((row) => ({
    ...rowToAnalyticsTopItem(row),
    failedFallbackEventCount: readInteger(row.failed_fallback_event_count),
    succeededFallbackEventCount: readInteger(row.succeeded_fallback_event_count),
  }));
}

function buildScopedActivityCte(
  input: AnalyticsQueryInput,
  range: AnalyticsRange,
): {
  sql: string;
  values: unknown[];
} {
  const clauses = ["request_activity.started_at >= $1", "request_activity.started_at < $2"];
  const values: unknown[] = [range.start, range.end];
  const add = (sql: string, value: string) => {
    values.push(value);
    clauses.push(sql.replace("?", `$${values.length}`));
  };

  if (input.filters.agentId) {
    add("agents.id = ?::uuid", input.filters.agentId);
  }
  if (input.filters.providerId) {
    add("request_activity.provider_id = ?::uuid", input.filters.providerId);
  }
  if (input.filters.virtualModelId) {
    add("request_activity.virtual_model_id = ?::uuid", input.filters.virtualModelId);
  }

  return {
    sql: `
      scoped_activity as (
        select request_activity.*,
               coalesce(request_activity.agent_name_snapshot, agents.name, 'Unknown agent')
                 as agent_label,
               coalesce(
                 request_activity.provider_display_name_snapshot,
                 providers.display_name,
                 'Unknown provider'
               ) as provider_label,
               case
                 when request_activity.provider_model_display_name_snapshot is not null
                   and request_activity.provider_model_name_snapshot is not null
                   then concat(
                     request_activity.provider_model_display_name_snapshot,
                     ' (',
                     request_activity.provider_model_name_snapshot,
                     ')'
                   )
                 when request_activity.provider_model_name_snapshot is not null
                   then request_activity.provider_model_name_snapshot
                 when provider_models.display_name is not null and provider_models.model_id is not null
                   then concat(provider_models.display_name, ' (', provider_models.model_id, ')')
                 when provider_models.model_id is not null then provider_models.model_id
                 else 'Unknown model'
               end as model_label,
               case
                 when request_activity.virtual_model_name_snapshot is not null
                   then request_activity.virtual_model_name_snapshot
                 when virtual_models.description is not null and virtual_models.name is not null
                   then concat(virtual_models.description, ' (', virtual_models.name, ')')
                 when virtual_models.name is not null then virtual_models.name
                 else 'Unknown virtual model'
               end as virtual_model_label,
               case
                 when route_policies.id is not null
                   then concat(
                     case
                       when request_activity.virtual_model_name_snapshot is not null
                         then request_activity.virtual_model_name_snapshot
                       when virtual_models.description is not null and virtual_models.name is not null
                         then concat(virtual_models.description, ' (', virtual_models.name, ')')
                       when virtual_models.name is not null then virtual_models.name
                       else 'Unknown virtual model'
                     end,
                     ' / ',
                     coalesce(request_activity.route_policy_strategy_snapshot, route_policies.strategy::text)
                   )
                 else 'Unknown route'
               end as route_label,
               concat(
                 coalesce(
                   request_activity.provider_display_name_snapshot,
                   providers.display_name,
                   'Unknown provider'
                 ),
                 ' / ',
                 case
                   when request_activity.provider_model_display_name_snapshot is not null
                     and request_activity.provider_model_name_snapshot is not null
                     then concat(
                       request_activity.provider_model_display_name_snapshot,
                       ' (',
                       request_activity.provider_model_name_snapshot,
                       ')'
                     )
                   when request_activity.provider_model_name_snapshot is not null
                     then request_activity.provider_model_name_snapshot
                   when provider_models.display_name is not null and provider_models.model_id is not null
                     then concat(provider_models.display_name, ' (', provider_models.model_id, ')')
                   when provider_models.model_id is not null then provider_models.model_id
                   else 'Unknown model'
                 end
               ) as provider_model_label
        from request_activity
        left join agents on agents.id = request_activity.agent_id
        left join providers on providers.id = request_activity.provider_id
        left join provider_models on provider_models.id = request_activity.provider_model_id
        left join virtual_models on virtual_models.id = request_activity.virtual_model_id
        left join route_policies on route_policies.id = request_activity.route_policy_id
        where ${clauses.join(" and ")}
      )
    `,
    values,
  };
}

const fallbackCountsSql = `
  select fallback_events.request_activity_id,
         count(fallback_events.id)::integer as fallback_event_count,
         count(fallback_events.id) filter (where fallback_events.status = 'failed')::integer
           as failed_fallback_event_count,
         count(fallback_events.id) filter (where fallback_events.status = 'succeeded')::integer
           as succeeded_fallback_event_count
  from fallback_events
  join scoped_activity on scoped_activity.id = fallback_events.request_activity_id
  group by fallback_events.request_activity_id
`;

const analyticsMetricSelectSql = `
  count(scoped_activity.id)::integer as request_count,
  count(scoped_activity.id) filter (where scoped_activity.status = 'failed')::integer
    as failure_count,
  case
    when count(scoped_activity.id) = 0 then 0
    else (
      count(scoped_activity.id) filter (where scoped_activity.status = 'failed')
    )::double precision / count(scoped_activity.id)::double precision
  end as failure_rate,
  coalesce(sum(request_usage.input_tokens), 0)::text as input_tokens,
  coalesce(sum(request_usage.output_tokens), 0)::text as output_tokens,
  coalesce(sum(request_usage.total_tokens), 0)::text as total_tokens,
  coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text as total_cost_usd,
  coalesce(sum(request_costs.savings_usd), 0)::numeric(20, 8)::text as total_savings_usd,
  (
    percentile_cont(0.95) within group (order by scoped_activity.latency_ms)
      filter (where scoped_activity.latency_ms is not null)
  )::double precision as p95_latency_ms,
  count(scoped_activity.id) filter (
    where coalesce(fallback_counts.fallback_event_count, 0) > 0
  )::integer as fallback_request_count,
  coalesce(sum(fallback_counts.fallback_event_count), 0)::integer as fallback_event_count
`;

const topAgentSql = {
  id: "coalesce(scoped_activity.agent_id::text, 'unknown-agent')",
  label: "coalesce(scoped_activity.agent_label, 'Unknown agent')",
};
const topProviderModelSql = {
  id: "coalesce(scoped_activity.provider_model_id::text, 'unknown-provider-model')",
  label: "coalesce(scoped_activity.provider_model_label, 'Unknown provider model')",
};
const topVirtualModelSql = {
  id: "coalesce(scoped_activity.virtual_model_id::text, 'unknown-virtual-model')",
  label: "coalesce(scoped_activity.virtual_model_label, 'Unknown virtual model')",
};
const topRouteSql = {
  id: "coalesce(scoped_activity.route_policy_id::text, 'unknown-route')",
  label: "coalesce(scoped_activity.route_label, 'Unknown route')",
};

function rowToAnalyticsKpis(row: AnalyticsKpiRow | undefined): ConsoleAnalyticsKpis {
  return {
    failureCount: row?.failure_count ?? 0,
    failureRate: readNumber(row?.failure_rate),
    fallbackEventCount: readInteger(row?.fallback_event_count),
    fallbackRequestCount: row?.fallback_request_count ?? 0,
    inputTokens: readInteger(row?.input_tokens),
    outputTokens: readInteger(row?.output_tokens),
    p95LatencyMs: readNullableNumber(row?.p95_latency_ms),
    requestCount: row?.request_count ?? 0,
    totalCostUsd: row?.total_cost_usd ?? null,
    totalSavingsUsd: row?.total_savings_usd ?? null,
    totalTokens: readInteger(row?.total_tokens),
  };
}

function rowToAnalyticsTopItem(row: AnalyticsTopRow): ConsoleAnalyticsTopItem {
  return {
    ...rowToAnalyticsKpis(row),
    id: row.id ?? "unknown",
    label: row.label ?? "Unknown",
  };
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

function readBucket(value: string | null | undefined): ConsoleAnalyticsBucket | undefined {
  const trimmed = readTrimmed(value);
  return trimmed && analyticsBuckets.has(trimmed as ConsoleAnalyticsBucket)
    ? (trimmed as ConsoleAnalyticsBucket)
    : undefined;
}

function normalizeTopLimit(value: number | string | null | undefined): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    return 5;
  }
  return Math.min(20, Math.max(1, Math.trunc(parsed)));
}

function readTrimmed(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readInteger(value: number | string | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readNumber(value: number | string | null | undefined): number {
  return readNullableNumber(value) ?? 0;
}

function readNullableNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
