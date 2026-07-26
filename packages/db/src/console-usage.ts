import { withPooledPostgresClient } from "@llmingress/db/client";
import { formatConsoleUsd } from "@llmingress/db/console-format";

export type ConsoleUsageWindow = "24h" | "7d" | "30d";

export type ConsoleUsageBreakdown = {
  avgLatencyMs: number | null;
  failureCount: number;
  modelId: string;
  modelLabel: string;
  providerId: string;
  providerLabel: string;
  requestCount: number;
  totalCostUsd: string | null;
  totalTokens: number;
};

export type ConsoleUsageDimensionBreakdown = {
  avgLatencyMs: number | null;
  failureCount: number;
  id: string;
  label: string;
  requestCount: number;
  totalCostUsd: string | null;
  totalTokens: number;
};

export type ConsoleUsageTrendPoint = {
  bucketStart: Date;
  cachedInputTokens: number;
  /** Requests whose status is 'failed' — canceled requests are neither. */
  failureCount: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  requestCount: number;
  totalCostUsd: string | null;
  totalTokens: number;
};

/** One route candidate's share of a virtual model's traffic in the window. */
export type ConsoleVirtualModelCandidateTraffic = {
  failureCount: number;
  providerModelId: string;
  requestCount: number;
  /** 0–1 of the virtual model's requests in the window; 0 when it saw none. */
  share: number;
};

export type ConsoleUsageSummary = {
  apiKeyBreakdowns: ConsoleUsageDimensionBreakdown[];
  avgLatencyMs: number | null;
  breakdowns: ConsoleUsageBreakdown[];
  /** Input tokens the provider served from its cache, a subset of inputTokens. */
  cachedInputTokens: number;
  failureCount: number;
  inputTokens: number;
  reasoningTokens: number;
  modelBreakdowns: ConsoleUsageDimensionBreakdown[];
  outputTokens: number;
  providerBreakdowns: ConsoleUsageDimensionBreakdown[];
  requestCount: number;
  totalCostUsd: string | null;
  totalTokens: number;
  trend: ConsoleUsageTrendPoint[];
  virtualModelBreakdowns: ConsoleUsageDimensionBreakdown[];
  window: ConsoleUsageWindow;
};

export type ConsoleUsageKpis = {
  failureRate: number;
  requestCount: number;
  totalCostUsd: string | null;
  totalTokens: number;
};

type UsageSummaryRow = {
  avg_latency_ms: number | string | null;
  cached_input_tokens?: string | null;
  failure_count: number;
  input_tokens: string | null;
  reasoning_tokens?: string | null;
  output_tokens: string | null;
  request_count: number;
  total_cost_usd: string | null;
  total_tokens: string | null;
};

type UsageBreakdownRow = {
  avg_latency_ms: number | string | null;
  failure_count: number;
  model_id: string | null;
  model_label: string | null;
  provider_id: string | null;
  provider_label: string | null;
  request_count: number;
  total_cost_usd: string | null;
  total_tokens: string | null;
};

type UsageDimensionBreakdownRow = {
  avg_latency_ms: number | string | null;
  failure_count: number;
  id: string | null;
  label: string | null;
  request_count: number;
  total_cost_usd: string | null;
  total_tokens: string | null;
};

type UsageTrendRow = {
  bucket_start: Date | string;
  cached_input_tokens: string | null;
  failure_count: number;
  input_tokens: string | null;
  output_tokens: string | null;
  reasoning_tokens: string | null;
  request_count: number;
  total_cost_usd: string | null;
  total_tokens: string | null;
};

export function parseConsoleUsageWindow(value: string | undefined): ConsoleUsageWindow {
  if (value === "24h" || value === "7d" || value === "30d") {
    return value;
  }
  return "7d";
}

export async function getConsoleUsageSummary(input: {
  apiKeyId?: string | null;
  dateFrom?: Date | null;
  dateTo?: Date | null;
  databaseUrl?: string;
  now?: Date;
  providerId?: string | null;
  virtualModelId?: string | null;
  window: ConsoleUsageWindow;
}): Promise<ConsoleUsageSummary> {
  const range = resolveUsageRange(input);
  const scope = buildUsageScope(input, range);
  const bucketUnit =
    range.end.getTime() - range.start.getTime() <= 48 * 60 * 60 * 1000 ? "hour" : "day";
  return withPooledPostgresClient(input.databaseUrl, async (client) => {
    const summaryResult = await client.query<UsageSummaryRow>(
      `
          select count(request_activity.id)::integer as request_count,
                 count(request_activity.id) filter (where request_activity.status = 'failed')::integer
                   as failure_count,
                 avg(request_activity.latency_ms) filter (
                   where request_activity.latency_ms is not null
                 )::double precision as avg_latency_ms,
                 coalesce(sum(request_usage.input_tokens), 0)::text as input_tokens,
                 coalesce(sum(request_usage.cached_input_tokens), 0)::text as cached_input_tokens,
                 coalesce(sum(request_usage.reasoning_tokens), 0)::text as reasoning_tokens,
                 coalesce(sum(request_usage.output_tokens), 0)::text as output_tokens,
                 coalesce(sum(request_usage.total_tokens), 0)::text as total_tokens,
                 coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
                   as total_cost_usd
          from request_activity
          left join request_usage on request_usage.request_activity_id = request_activity.id
          left join request_costs on request_costs.request_activity_id = request_activity.id
          where ${scope.whereSql}
        `,
      scope.values,
    );
    const breakdownResult = await client.query<UsageBreakdownRow>(
      `
          select request_activity.provider_id::text as provider_id,
                 request_activity.provider_model_id::text as model_id,
                 coalesce(
                   (array_agg(
                     request_activity.provider_display_name_snapshot
                     order by request_activity.started_at desc
                   ) filter (where request_activity.provider_display_name_snapshot is not null))[1],
                   max(providers.display_name),
                   'Unknown provider'
                 ) as provider_label,
                 coalesce(
                   (array_agg(
                     request_activity.provider_model_display_name_snapshot
                     order by request_activity.started_at desc
                   ) filter (where request_activity.provider_model_display_name_snapshot is not null))[1],
                   max(provider_models.display_name),
                   'Unknown model'
                 ) as model_label,
                 count(request_activity.id)::integer as request_count,
                 count(request_activity.id) filter (where request_activity.status = 'failed')::integer
                   as failure_count,
                 avg(request_activity.latency_ms) filter (
                   where request_activity.latency_ms is not null
                 )::double precision as avg_latency_ms,
                 coalesce(sum(request_usage.total_tokens), 0)::text as total_tokens,
                 coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
                   as total_cost_usd
          from request_activity
          left join providers on providers.id = request_activity.provider_id
          left join provider_models on provider_models.id = request_activity.provider_model_id
          left join request_usage on request_usage.request_activity_id = request_activity.id
          left join request_costs on request_costs.request_activity_id = request_activity.id
          where ${scope.whereSql}
          group by request_activity.provider_id,
                   request_activity.provider_model_id
          order by coalesce(sum(request_costs.total_cost_usd), 0) desc,
                   count(request_activity.id) desc,
                   provider_label,
                   model_label
        `,
      scope.values,
    );
    const apiKeyBreakdownResult = await client.query<UsageDimensionBreakdownRow>(
      `
          select coalesce(request_activity.api_key_id::text, 'unknown-api-key') as id,
                 coalesce(
                   (array_agg(
                     request_activity.api_key_name_snapshot
                     order by request_activity.started_at desc
                   ) filter (where request_activity.api_key_name_snapshot is not null))[1],
                   max(api_keys.name),
                   'Unknown apiKey'
                 )
                   as label,
                 count(request_activity.id)::integer as request_count,
                 count(request_activity.id) filter (where request_activity.status = 'failed')::integer
                   as failure_count,
                 avg(request_activity.latency_ms) filter (
                   where request_activity.latency_ms is not null
                 )::double precision as avg_latency_ms,
                 coalesce(sum(request_usage.total_tokens), 0)::text as total_tokens,
                 coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
                   as total_cost_usd
          from request_activity
          left join api_keys on api_keys.id = request_activity.api_key_id
          left join request_usage on request_usage.request_activity_id = request_activity.id
          left join request_costs on request_costs.request_activity_id = request_activity.id
          where ${scope.whereSql}
          group by request_activity.api_key_id
          order by min(request_activity.created_at),
                   label
        `,
      scope.values,
    );
    const virtualModelBreakdownResult = await client.query<UsageDimensionBreakdownRow>(
      `
          select coalesce(request_activity.virtual_model_id::text, 'unknown-virtual-model') as id,
                 coalesce(
                   (array_agg(
                     request_activity.virtual_model_name_snapshot
                     order by request_activity.started_at desc
                   ) filter (where request_activity.virtual_model_name_snapshot is not null))[1],
                   case
                     when max(virtual_models.description) is not null
                       and max(virtual_models.name) is not null
                       then concat(max(virtual_models.description), ' (', max(virtual_models.name), ')')
                     when max(virtual_models.name) is not null then max(virtual_models.name)
                   end,
                   'Unknown virtual model'
                 ) as label,
                 count(request_activity.id)::integer as request_count,
                 count(request_activity.id) filter (where request_activity.status = 'failed')::integer
                   as failure_count,
                 avg(request_activity.latency_ms) filter (
                   where request_activity.latency_ms is not null
                 )::double precision as avg_latency_ms,
                 coalesce(sum(request_usage.total_tokens), 0)::text as total_tokens,
                 coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
                   as total_cost_usd
          from request_activity
          left join virtual_models on virtual_models.id = request_activity.virtual_model_id
          left join request_usage on request_usage.request_activity_id = request_activity.id
          left join request_costs on request_costs.request_activity_id = request_activity.id
          where ${scope.whereSql}
          group by request_activity.virtual_model_id
          order by min(request_activity.created_at),
                   label
        `,
      scope.values,
    );
    const providerBreakdownResult = await client.query<UsageDimensionBreakdownRow>(
      `
          select coalesce(request_activity.provider_id::text, 'unknown-provider') as id,
                 coalesce(
                   (array_agg(
                     request_activity.provider_display_name_snapshot
                     order by request_activity.started_at desc
                   ) filter (where request_activity.provider_display_name_snapshot is not null))[1],
                   max(providers.display_name),
                   'Unknown provider'
                 ) as label,
                 count(request_activity.id)::integer as request_count,
                 count(request_activity.id) filter (where request_activity.status = 'failed')::integer
                   as failure_count,
                 avg(request_activity.latency_ms) filter (
                   where request_activity.latency_ms is not null
                 )::double precision as avg_latency_ms,
                 coalesce(sum(request_usage.total_tokens), 0)::text as total_tokens,
                 coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
                   as total_cost_usd
          from request_activity
          left join providers on providers.id = request_activity.provider_id
          left join request_usage on request_usage.request_activity_id = request_activity.id
          left join request_costs on request_costs.request_activity_id = request_activity.id
          where ${scope.whereSql}
          group by request_activity.provider_id
          order by min(request_activity.created_at),
                   label
        `,
      scope.values,
    );
    const modelBreakdownResult = await client.query<UsageDimensionBreakdownRow>(
      `
          select coalesce(request_activity.provider_model_id::text, 'unknown-model') as id,
                 coalesce(
                   case
                     when (
                       array_agg(
                         request_activity.provider_model_display_name_snapshot
                         order by request_activity.started_at desc
                       ) filter (
                         where request_activity.provider_model_display_name_snapshot is not null
                       )
                     )[1] is not null
                       and (
                         array_agg(
                           request_activity.provider_model_name_snapshot
                           order by request_activity.started_at desc
                         ) filter (where request_activity.provider_model_name_snapshot is not null)
                       )[1] is not null
                     then concat(
                       (
                         array_agg(
                           request_activity.provider_model_display_name_snapshot
                           order by request_activity.started_at desc
                         ) filter (
                           where request_activity.provider_model_display_name_snapshot is not null
                         )
                       )[1],
                       ' (',
                       (
                         array_agg(
                           request_activity.provider_model_name_snapshot
                           order by request_activity.started_at desc
                         ) filter (where request_activity.provider_model_name_snapshot is not null)
                       )[1],
                       ')'
                     )
                   end,
                   (array_agg(
                     request_activity.provider_model_name_snapshot
                     order by request_activity.started_at desc
                   ) filter (where request_activity.provider_model_name_snapshot is not null))[1],
                   case
                     when max(provider_models.display_name) is not null
                       and max(provider_models.model_id) is not null
                       then concat(max(provider_models.display_name), ' (', max(provider_models.model_id), ')')
                     when max(provider_models.model_id) is not null then max(provider_models.model_id)
                   end,
                   'Unknown model'
                 ) as label,
                 count(request_activity.id)::integer as request_count,
                 count(request_activity.id) filter (where request_activity.status = 'failed')::integer
                   as failure_count,
                 avg(request_activity.latency_ms) filter (
                   where request_activity.latency_ms is not null
                 )::double precision as avg_latency_ms,
                 coalesce(sum(request_usage.total_tokens), 0)::text as total_tokens,
                 coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
                   as total_cost_usd
          from request_activity
          left join provider_models on provider_models.id = request_activity.provider_model_id
          left join request_usage on request_usage.request_activity_id = request_activity.id
          left join request_costs on request_costs.request_activity_id = request_activity.id
          where ${scope.whereSql}
          group by request_activity.provider_model_id
          order by min(request_activity.created_at),
                   label
        `,
      scope.values,
    );
    const trendResult = await client.query<UsageTrendRow>(
      `
          select date_trunc('${bucketUnit}', request_activity.started_at) as bucket_start,
                 count(request_activity.id)::integer as request_count,
                 count(request_activity.id) filter (where request_activity.status = 'failed')::integer
                   as failure_count,
                 coalesce(sum(request_usage.input_tokens), 0)::text as input_tokens,
                 coalesce(sum(request_usage.cached_input_tokens), 0)::text as cached_input_tokens,
                 coalesce(sum(request_usage.output_tokens), 0)::text as output_tokens,
                 coalesce(sum(request_usage.reasoning_tokens), 0)::text as reasoning_tokens,
                 coalesce(sum(request_usage.total_tokens), 0)::text as total_tokens,
                 coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
                   as total_cost_usd
          from request_activity
          left join request_usage on request_usage.request_activity_id = request_activity.id
          left join request_costs on request_costs.request_activity_id = request_activity.id
          where ${scope.whereSql}
          group by bucket_start
          order by bucket_start
        `,
      scope.values,
    );
    const summaryRow = summaryResult.rows[0];

    return {
      apiKeyBreakdowns: apiKeyBreakdownResult.rows.map(rowToConsoleUsageDimensionBreakdown),
      avgLatencyMs: readOptionalNumber(summaryRow?.avg_latency_ms),
      breakdowns: breakdownResult.rows.map(rowToConsoleUsageBreakdown),
      cachedInputTokens: readInteger(summaryRow?.cached_input_tokens),
      failureCount: summaryRow?.failure_count ?? 0,
      inputTokens: readInteger(summaryRow?.input_tokens),
      modelBreakdowns: modelBreakdownResult.rows.map(rowToConsoleUsageDimensionBreakdown),
      outputTokens: readInteger(summaryRow?.output_tokens),
      reasoningTokens: readInteger(summaryRow?.reasoning_tokens),
      providerBreakdowns: providerBreakdownResult.rows.map(rowToConsoleUsageDimensionBreakdown),
      requestCount: summaryRow?.request_count ?? 0,
      totalCostUsd: summaryRow?.total_cost_usd ?? null,
      totalTokens: readInteger(summaryRow?.total_tokens),
      trend: trendResult.rows.map(rowToConsoleUsageTrendPoint),
      virtualModelBreakdowns: virtualModelBreakdownResult.rows.map(
        rowToConsoleUsageDimensionBreakdown,
      ),
      window: input.window,
    };
  });
}

const usageWindowMs: Record<ConsoleUsageWindow, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export async function getConsolePrevious24HourKpis(
  input: { databaseUrl?: string; now?: Date } = {},
): Promise<ConsoleUsageKpis> {
  return getConsolePreviousWindowKpis({ ...input, window: "24h" });
}

/**
 * KPIs for the window immediately before the one on screen, so the Overview can
 * show a period-over-period delta for whichever window is selected.
 */
export async function getConsolePreviousWindowKpis(input: {
  databaseUrl?: string;
  now?: Date;
  window: ConsoleUsageWindow;
}): Promise<ConsoleUsageKpis> {
  const now = input.now ?? new Date();
  const span = usageWindowMs[input.window];
  const end = new Date(now.getTime() - span);
  const start = new Date(end.getTime() - span);

  return withPooledPostgresClient(input.databaseUrl, async (client) => {
    const result = await client.query<UsageSummaryRow>(
      `
        select count(request_activity.id)::integer as request_count,
               count(request_activity.id) filter (where request_activity.status = 'failed')::integer
                 as failure_count,
               null::double precision as avg_latency_ms,
               '0'::text as input_tokens,
               '0'::text as output_tokens,
               coalesce(sum(request_usage.total_tokens), 0)::text as total_tokens,
               coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
                 as total_cost_usd
        from request_activity
        left join request_usage on request_usage.request_activity_id = request_activity.id
        left join request_costs on request_costs.request_activity_id = request_activity.id
        where request_activity.started_at >= $1
          and request_activity.started_at < $2
      `,
      [start.toISOString(), end.toISOString()],
    );
    const row = result.rows[0];
    const requestCount = row?.request_count ?? 0;
    const failureCount = row?.failure_count ?? 0;
    return {
      failureRate: requestCount > 0 ? failureCount / requestCount : 0,
      requestCount,
      totalCostUsd: row?.total_cost_usd ?? null,
      totalTokens: readInteger(row?.total_tokens),
    };
  });
}

/**
 * Traffic per route candidate of one virtual model. modelBreakdowns aggregates a
 * provider model across every virtual model that routes to it, which would
 * overstate a candidate shared by two routes; this groups by the pair instead.
 */
export async function listConsoleVirtualModelCandidateTraffic(input: {
  databaseUrl?: string;
  now?: Date;
  virtualModelId: string;
  window: ConsoleUsageWindow;
}): Promise<ConsoleVirtualModelCandidateTraffic[]> {
  const now = input.now ?? new Date();
  const start = new Date(now.getTime() - usageWindowMs[input.window]);

  return withPooledPostgresClient(input.databaseUrl, async (client) => {
    const result = await client.query<{
      failure_count: number;
      provider_model_id: string;
      request_count: number;
    }>(
      `
        select request_activity.provider_model_id::text as provider_model_id,
               count(request_activity.id)::integer as request_count,
               count(request_activity.id) filter (where request_activity.status = 'failed')::integer
                 as failure_count
        from request_activity
        where request_activity.virtual_model_id = $1
          and request_activity.provider_model_id is not null
          and request_activity.started_at >= $2
          and request_activity.started_at <= $3
        group by request_activity.provider_model_id
      `,
      [input.virtualModelId, start.toISOString(), now.toISOString()],
    );

    const total = result.rows.reduce((sum, row) => sum + row.request_count, 0);
    return result.rows.map((row) => ({
      failureCount: row.failure_count,
      providerModelId: row.provider_model_id,
      requestCount: row.request_count,
      share: total > 0 ? row.request_count / total : 0,
    }));
  });
}

export function formatConsoleUsageCost(totalCostUsd: string | null): string {
  return formatConsoleUsd(totalCostUsd);
}

function rowToConsoleUsageBreakdown(row: UsageBreakdownRow): ConsoleUsageBreakdown {
  return {
    avgLatencyMs: readOptionalNumber(row.avg_latency_ms),
    failureCount: row.failure_count,
    modelId: row.model_id ?? "unknown-model",
    modelLabel: row.model_label ?? "Unknown model",
    providerId: row.provider_id ?? "unknown-provider",
    providerLabel: row.provider_label ?? "Unknown provider",
    requestCount: row.request_count,
    totalCostUsd: row.total_cost_usd,
    totalTokens: readInteger(row.total_tokens),
  };
}

function rowToConsoleUsageDimensionBreakdown(
  row: UsageDimensionBreakdownRow,
): ConsoleUsageDimensionBreakdown {
  return {
    avgLatencyMs: readOptionalNumber(row.avg_latency_ms),
    failureCount: row.failure_count,
    id: row.id ?? "unknown",
    label: row.label ?? "Unknown",
    requestCount: row.request_count,
    totalCostUsd: row.total_cost_usd,
    totalTokens: readInteger(row.total_tokens),
  };
}

function rowToConsoleUsageTrendPoint(row: UsageTrendRow): ConsoleUsageTrendPoint {
  return {
    bucketStart: row.bucket_start instanceof Date ? row.bucket_start : new Date(row.bucket_start),
    cachedInputTokens: readInteger(row.cached_input_tokens),
    failureCount: row.failure_count,
    inputTokens: readInteger(row.input_tokens),
    outputTokens: readInteger(row.output_tokens),
    reasoningTokens: readInteger(row.reasoning_tokens),
    requestCount: row.request_count,
    totalCostUsd: row.total_cost_usd,
    totalTokens: readInteger(row.total_tokens),
  };
}

function resolveUsageRange(input: {
  dateFrom?: Date | null;
  dateTo?: Date | null;
  now?: Date;
  window: ConsoleUsageWindow;
}): { end: Date; start: Date } {
  const now = input.now ?? new Date();
  const start = input.dateFrom ?? getUsageWindowStart(now, input.window);
  const end = input.dateTo ?? now;

  if (end.getTime() <= start.getTime()) {
    return {
      end: new Date(start.getTime() + 24 * 60 * 60 * 1000),
      start,
    };
  }

  return { end, start };
}

function buildUsageScope(
  input: {
    apiKeyId?: string | null;
    providerId?: string | null;
    virtualModelId?: string | null;
  },
  range: { end: Date; start: Date },
): { values: unknown[]; whereSql: string } {
  const values: unknown[] = [range.start.toISOString(), range.end.toISOString()];
  const clauses = ["request_activity.started_at >= $1", "request_activity.started_at < $2"];

  if (input.apiKeyId) {
    values.push(input.apiKeyId);
    clauses.push(`request_activity.api_key_id = $${values.length}::uuid`);
  }
  if (input.virtualModelId) {
    values.push(input.virtualModelId);
    clauses.push(`request_activity.virtual_model_id = $${values.length}::uuid`);
  }
  if (input.providerId) {
    values.push(input.providerId);
    clauses.push(`request_activity.provider_id = $${values.length}::uuid`);
  }

  return { values, whereSql: clauses.join("\n            and ") };
}

function getUsageWindowStart(now: Date, window: ConsoleUsageWindow): Date {
  const durationMs = {
    "24h": 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
  }[window];

  return new Date(now.getTime() - durationMs);
}

function readInteger(value: string | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readOptionalNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

/**
 * The distribution panels on Usage. Each answers a different question about the
 * same window, so they are gathered in one call rather than one query per panel.
 */
export type ConsoleUsageBreakouts = {
  costSources: Array<{ requestCount: number; source: string; totalCostUsd: string | null }>;
  fallback: {
    /** Succeeded only after an earlier candidate failed. */
    recoveredOnRetry: number;
    /** Failed with no candidate left to try. */
    failedAfterLastCandidate: number;
  };
  protocols: Array<{ avgLatencyMs: number | null; protocol: string; requestCount: number }>;
  statuses: Array<{ requestCount: number; status: string }>;
  streaming: { nonStreamed: number; streamed: number };
  tokenSources: Array<{ requestCount: number; source: string }>;
  topErrors: Array<{ count: number; errorCode: string; httpStatus: number | null }>;
};

export async function getConsoleUsageBreakouts(input: {
  databaseUrl?: string;
  now?: Date;
  window: ConsoleUsageWindow;
}): Promise<ConsoleUsageBreakouts> {
  const now = input.now ?? new Date();
  const start = new Date(now.getTime() - usageWindowMs[input.window]);
  const range = [start.toISOString(), now.toISOString()];

  return withPooledPostgresClient(input.databaseUrl, async (client) => {
    const scope = "request_activity.started_at >= $1 and request_activity.started_at <= $2";

    // One pooled client cannot run these concurrently — pg serialises them and
    // warns about it — so each query awaits in turn.
    const tokenSources = await client.query<{ request_count: number; source: string }>(
      `
        select coalesce(request_usage.token_source, 'unavailable') as source,
               count(*)::integer as request_count
        from request_activity
        left join request_usage on request_usage.request_activity_id = request_activity.id
        where ${scope}
        group by source
        order by request_count desc
      `,
      range,
    );
    const costSources = await client.query<{
      request_count: number;
      source: string;
      total_cost_usd: string | null;
    }>(
      `
        select coalesce(request_costs.cost_source, 'unavailable') as source,
               count(*)::integer as request_count,
               sum(request_costs.total_cost_usd)::numeric(20, 8)::text as total_cost_usd
        from request_activity
        left join request_costs on request_costs.request_activity_id = request_activity.id
        where ${scope}
        group by source
        order by request_count desc
      `,
      range,
    );
    const protocols = await client.query<{
      avg_latency_ms: number | null;
      protocol: string;
      request_count: number;
    }>(
      `
        select request_activity.protocol,
               count(*)::integer as request_count,
               avg(request_activity.latency_ms) filter (
                 where request_activity.latency_ms is not null
               )::double precision as avg_latency_ms
        from request_activity
        where ${scope}
        group by request_activity.protocol
        order by request_count desc
      `,
      range,
    );
    const statuses = await client.query<{ request_count: number; status: string }>(
      `
        select request_activity.status, count(*)::integer as request_count
        from request_activity
        where ${scope}
        group by request_activity.status
        order by request_count desc
      `,
      range,
    );
    const streaming = await client.query<{ non_streamed: number; streamed: number }>(
      `
        select count(*) filter (where request_activity.stream)::integer as streamed,
               count(*) filter (where not request_activity.stream)::integer as non_streamed
        from request_activity
        where ${scope}
      `,
      range,
    );
    const fallback = await client.query<{
      failed_after_last_candidate: number;
      recovered_on_retry: number;
    }>(
      `
        with attempts as (
          select request_activity.id,
                 request_activity.status,
                 count(fallback_events.id) filter (where fallback_events.status = 'failed')
                   as failed_attempts
          from request_activity
          join fallback_events on fallback_events.request_activity_id = request_activity.id
          where ${scope}
          group by request_activity.id, request_activity.status
        )
        select count(*) filter (where status = 'succeeded' and failed_attempts > 0)::integer
                 as recovered_on_retry,
               count(*) filter (where status = 'failed')::integer as failed_after_last_candidate
        from attempts
      `,
      range,
    );
    const topErrors = await client.query<{
      count: number;
      error_code: string;
      http_status: number | null;
    }>(
      `
        select request_activity.error_code,
               max(request_activity.http_status)::integer as http_status,
               count(*)::integer as count
        from request_activity
        where ${scope}
          and request_activity.status = 'failed'
          and request_activity.error_code is not null
        group by request_activity.error_code
        order by count desc, request_activity.error_code
        limit 5
      `,
      range,
    );

    return {
      costSources: costSources.rows.map((row) => ({
        requestCount: row.request_count,
        source: row.source,
        totalCostUsd: row.total_cost_usd,
      })),
      fallback: {
        failedAfterLastCandidate: fallback.rows[0]?.failed_after_last_candidate ?? 0,
        recoveredOnRetry: fallback.rows[0]?.recovered_on_retry ?? 0,
      },
      protocols: protocols.rows.map((row) => ({
        avgLatencyMs: readOptionalNumber(row.avg_latency_ms),
        protocol: row.protocol,
        requestCount: row.request_count,
      })),
      statuses: statuses.rows.map((row) => ({
        requestCount: row.request_count,
        status: row.status,
      })),
      streaming: {
        nonStreamed: streaming.rows[0]?.non_streamed ?? 0,
        streamed: streaming.rows[0]?.streamed ?? 0,
      },
      tokenSources: tokenSources.rows.map((row) => ({
        requestCount: row.request_count,
        source: row.source,
      })),
      topErrors: topErrors.rows.map((row) => ({
        count: row.count,
        errorCode: row.error_code,
        httpStatus: row.http_status,
      })),
    };
  });
}
