import { PostgresClient, type PostgresQueryResultRow } from "@llmingress/db/activity";

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
  totalSavingsUsd: string | null;
  totalTokens: number;
};

export type ConsoleUsageDimensionBreakdown = {
  avgLatencyMs: number | null;
  failureCount: number;
  id: string;
  label: string;
  requestCount: number;
  totalCostUsd: string | null;
  totalSavingsUsd: string | null;
  totalTokens: number;
};

export type ConsoleUsageTrendPoint = {
  bucketStart: Date;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  totalCostUsd: string | null;
  totalSavingsUsd: string | null;
  totalTokens: number;
};

export type ConsoleUsageSummary = {
  agentBreakdowns: ConsoleUsageDimensionBreakdown[];
  avgLatencyMs: number | null;
  breakdowns: ConsoleUsageBreakdown[];
  costedRequestCount: number;
  failureCount: number;
  inputTokens: number;
  lowCostRequestCount: number;
  modelBreakdowns: ConsoleUsageDimensionBreakdown[];
  outputTokens: number;
  providerBreakdowns: ConsoleUsageDimensionBreakdown[];
  requestCount: number;
  totalCostUsd: string | null;
  totalSavingsUsd: string | null;
  totalTokens: number;
  trend: ConsoleUsageTrendPoint[];
  virtualModelBreakdowns: ConsoleUsageDimensionBreakdown[];
  window: ConsoleUsageWindow;
};

type UsageSummaryRow = PostgresQueryResultRow & {
  avg_latency_ms: number | string | null;
  costed_request_count: number;
  failure_count: number;
  input_tokens: string | null;
  low_cost_request_count: number;
  output_tokens: string | null;
  request_count: number;
  total_cost_usd: string | null;
  total_savings_usd: string | null;
  total_tokens: string | null;
};

type UsageBreakdownRow = PostgresQueryResultRow & {
  avg_latency_ms: number | string | null;
  failure_count: number;
  model_id: string | null;
  model_label: string | null;
  provider_id: string | null;
  provider_label: string | null;
  request_count: number;
  total_cost_usd: string | null;
  total_savings_usd: string | null;
  total_tokens: string | null;
};

type UsageDimensionBreakdownRow = PostgresQueryResultRow & {
  avg_latency_ms: number | string | null;
  failure_count: number;
  id: string | null;
  label: string | null;
  request_count: number;
  total_cost_usd: string | null;
  total_savings_usd: string | null;
  total_tokens: string | null;
};

type UsageTrendRow = PostgresQueryResultRow & {
  bucket_start: Date | string;
  input_tokens: string | null;
  output_tokens: string | null;
  request_count: number;
  total_cost_usd: string | null;
  total_savings_usd: string | null;
  total_tokens: string | null;
};

export function parseConsoleUsageWindow(value: string | undefined): ConsoleUsageWindow {
  if (value === "7d" || value === "30d") {
    return value;
  }
  return "24h";
}

export async function getConsoleUsageSummary(input: {
  agentId?: string | null;
  dateFrom?: Date | null;
  dateTo?: Date | null;
  databaseUrl: string;
  now?: Date;
  providerId?: string | null;
  virtualModelId?: string | null;
  window: ConsoleUsageWindow;
}): Promise<ConsoleUsageSummary> {
  const range = resolveUsageRange(input);
  const scope = buildUsageScope(input, range);
  const bucketUnit =
    range.end.getTime() - range.start.getTime() <= 48 * 60 * 60 * 1000 ? "hour" : "day";
  const client = new PostgresClient({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    const summaryResult = await client.query<UsageSummaryRow>(
      `
          select count(request_activity.id)::integer as request_count,
                 count(request_activity.id) filter (where request_activity.status = 'failed')::integer
                   as failure_count,
                 avg(request_activity.latency_ms) filter (
                   where request_activity.latency_ms is not null
                 )::double precision as avg_latency_ms,
                 count(request_costs.id) filter (
                   where request_costs.total_cost_usd is not null
                 )::integer as costed_request_count,
                 count(request_costs.id) filter (
                   where coalesce(request_costs.savings_usd, 0) > 0
                 )::integer as low_cost_request_count,
                 coalesce(sum(request_usage.input_tokens), 0)::text as input_tokens,
                 coalesce(sum(request_usage.output_tokens), 0)::text as output_tokens,
                 coalesce(sum(request_usage.total_tokens), 0)::text as total_tokens,
                 coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
                   as total_cost_usd,
                 coalesce(sum(request_costs.savings_usd), 0)::numeric(20, 8)::text
                   as total_savings_usd
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
                   request_activity.provider_display_name_snapshot,
                   providers.display_name
                 ) as provider_label,
                 coalesce(
                   request_activity.provider_model_display_name_snapshot,
                   provider_models.display_name
                 ) as model_label,
                 count(request_activity.id)::integer as request_count,
                 count(request_activity.id) filter (where request_activity.status = 'failed')::integer
                   as failure_count,
                 avg(request_activity.latency_ms) filter (
                   where request_activity.latency_ms is not null
                 )::double precision as avg_latency_ms,
                 coalesce(sum(request_usage.total_tokens), 0)::text as total_tokens,
                 coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
                   as total_cost_usd,
                 coalesce(sum(request_costs.savings_usd), 0)::numeric(20, 8)::text
                   as total_savings_usd
          from request_activity
          left join providers on providers.id = request_activity.provider_id
          left join provider_models on provider_models.id = request_activity.provider_model_id
          left join request_usage on request_usage.request_activity_id = request_activity.id
          left join request_costs on request_costs.request_activity_id = request_activity.id
          where ${scope.whereSql}
          group by request_activity.provider_id,
                   request_activity.provider_model_id,
                   request_activity.provider_display_name_snapshot,
                   providers.display_name,
                   request_activity.provider_model_display_name_snapshot,
                   provider_models.display_name
          order by coalesce(sum(request_costs.total_cost_usd), 0) desc,
                   count(request_activity.id) desc,
                   providers.display_name,
                   provider_models.display_name
        `,
      scope.values,
    );
    const agentBreakdownResult = await client.query<UsageDimensionBreakdownRow>(
      `
          select coalesce(agents.id::text, 'unknown-agent') as id,
                 coalesce(request_activity.agent_name_snapshot, agents.name, 'Unknown agent')
                   as label,
                 count(request_activity.id)::integer as request_count,
                 count(request_activity.id) filter (where request_activity.status = 'failed')::integer
                   as failure_count,
                 avg(request_activity.latency_ms) filter (
                   where request_activity.latency_ms is not null
                 )::double precision as avg_latency_ms,
                 coalesce(sum(request_usage.total_tokens), 0)::text as total_tokens,
                 coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
                   as total_cost_usd,
                 coalesce(sum(request_costs.savings_usd), 0)::numeric(20, 8)::text
                   as total_savings_usd
          from request_activity
          left join agents on agents.id = request_activity.agent_id
          left join request_usage on request_usage.request_activity_id = request_activity.id
          left join request_costs on request_costs.request_activity_id = request_activity.id
          where ${scope.whereSql}
          group by agents.id,
                 request_activity.agent_name_snapshot,
                 agents.name
          order by min(request_activity.created_at),
                   label
        `,
      scope.values,
    );
    const virtualModelBreakdownResult = await client.query<UsageDimensionBreakdownRow>(
      `
          select coalesce(request_activity.virtual_model_id::text, 'unknown-virtual-model') as id,
                 case
                   when request_activity.virtual_model_name_snapshot is not null
                     then request_activity.virtual_model_name_snapshot
                   when virtual_models.description is not null and virtual_models.name is not null
                     then concat(virtual_models.description, ' (', virtual_models.name, ')')
                   when virtual_models.name is not null then virtual_models.name
                   else 'Unknown virtual model'
                 end as label,
                 count(request_activity.id)::integer as request_count,
                 count(request_activity.id) filter (where request_activity.status = 'failed')::integer
                   as failure_count,
                 avg(request_activity.latency_ms) filter (
                   where request_activity.latency_ms is not null
                 )::double precision as avg_latency_ms,
                 coalesce(sum(request_usage.total_tokens), 0)::text as total_tokens,
                 coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
                   as total_cost_usd,
                 coalesce(sum(request_costs.savings_usd), 0)::numeric(20, 8)::text
                   as total_savings_usd
          from request_activity
          left join virtual_models on virtual_models.id = request_activity.virtual_model_id
          left join request_usage on request_usage.request_activity_id = request_activity.id
          left join request_costs on request_costs.request_activity_id = request_activity.id
          where ${scope.whereSql}
          group by request_activity.virtual_model_id,
                   virtual_models.description,
                   virtual_models.name,
                   request_activity.virtual_model_name_snapshot
          order by min(request_activity.created_at),
                   label
        `,
      scope.values,
    );
    const providerBreakdownResult = await client.query<UsageDimensionBreakdownRow>(
      `
          select coalesce(request_activity.provider_id::text, 'unknown-provider') as id,
                 coalesce(
                   request_activity.provider_display_name_snapshot,
                   providers.display_name,
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
                   as total_cost_usd,
                 coalesce(sum(request_costs.savings_usd), 0)::numeric(20, 8)::text
                   as total_savings_usd
          from request_activity
          left join providers on providers.id = request_activity.provider_id
          left join request_usage on request_usage.request_activity_id = request_activity.id
          left join request_costs on request_costs.request_activity_id = request_activity.id
          where ${scope.whereSql}
          group by request_activity.provider_id,
                   request_activity.provider_display_name_snapshot,
                   providers.display_name
          order by min(request_activity.created_at),
                   label
        `,
      scope.values,
    );
    const modelBreakdownResult = await client.query<UsageDimensionBreakdownRow>(
      `
          select coalesce(request_activity.provider_model_id::text, 'unknown-model') as id,
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
                 end as label,
                 count(request_activity.id)::integer as request_count,
                 count(request_activity.id) filter (where request_activity.status = 'failed')::integer
                   as failure_count,
                 avg(request_activity.latency_ms) filter (
                   where request_activity.latency_ms is not null
                 )::double precision as avg_latency_ms,
                 coalesce(sum(request_usage.total_tokens), 0)::text as total_tokens,
                 coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
                   as total_cost_usd,
                 coalesce(sum(request_costs.savings_usd), 0)::numeric(20, 8)::text
                   as total_savings_usd
          from request_activity
          left join provider_models on provider_models.id = request_activity.provider_model_id
          left join request_usage on request_usage.request_activity_id = request_activity.id
          left join request_costs on request_costs.request_activity_id = request_activity.id
          where ${scope.whereSql}
          group by request_activity.provider_model_id,
                   provider_models.display_name,
                   provider_models.model_id,
                   request_activity.provider_model_display_name_snapshot,
                   request_activity.provider_model_name_snapshot
          order by min(request_activity.created_at),
                   label
        `,
      scope.values,
    );
    const trendResult = await client.query<UsageTrendRow>(
      `
          select date_trunc('${bucketUnit}', request_activity.started_at) as bucket_start,
                 count(request_activity.id)::integer as request_count,
                 coalesce(sum(request_usage.input_tokens), 0)::text as input_tokens,
                 coalesce(sum(request_usage.output_tokens), 0)::text as output_tokens,
                 coalesce(sum(request_usage.total_tokens), 0)::text as total_tokens,
                 coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
                   as total_cost_usd,
                 coalesce(sum(request_costs.savings_usd), 0)::numeric(20, 8)::text
                   as total_savings_usd
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
      agentBreakdowns: agentBreakdownResult.rows.map(rowToConsoleUsageDimensionBreakdown),
      avgLatencyMs: readOptionalNumber(summaryRow?.avg_latency_ms),
      breakdowns: breakdownResult.rows.map(rowToConsoleUsageBreakdown),
      costedRequestCount: summaryRow?.costed_request_count ?? 0,
      failureCount: summaryRow?.failure_count ?? 0,
      inputTokens: readInteger(summaryRow?.input_tokens),
      lowCostRequestCount: summaryRow?.low_cost_request_count ?? 0,
      modelBreakdowns: modelBreakdownResult.rows.map(rowToConsoleUsageDimensionBreakdown),
      outputTokens: readInteger(summaryRow?.output_tokens),
      providerBreakdowns: providerBreakdownResult.rows.map(rowToConsoleUsageDimensionBreakdown),
      requestCount: summaryRow?.request_count ?? 0,
      totalCostUsd: summaryRow?.total_cost_usd ?? null,
      totalSavingsUsd: summaryRow?.total_savings_usd ?? null,
      totalTokens: readInteger(summaryRow?.total_tokens),
      trend: trendResult.rows.map(rowToConsoleUsageTrendPoint),
      virtualModelBreakdowns: virtualModelBreakdownResult.rows.map(
        rowToConsoleUsageDimensionBreakdown,
      ),
      window: input.window,
    };
  } finally {
    await client.end();
  }
}

export function formatConsoleUsageCost(totalCostUsd: string | null): string {
  const numericCost = totalCostUsd === null ? 0 : Number(totalCostUsd);
  if (!Number.isFinite(numericCost)) {
    return "$0.00000000";
  }
  return `$${numericCost.toFixed(8)}`;
}

export function formatConsoleUsageTokens(input: {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}): string {
  return `${input.totalTokens} total tokens (${input.inputTokens} input, ${input.outputTokens} output)`;
}

export function formatConsoleUsageBreakdownStats(input: {
  failureCount: number;
  requestCount: number;
  totalCostUsd: string | null;
  totalSavingsUsd: string | null;
  totalTokens: number;
}): string {
  const requestLabel = input.requestCount === 1 ? "request" : "requests";
  const failureLabel = input.failureCount === 1 ? "failure" : "failures";
  return `${input.requestCount} ${requestLabel} - ${input.failureCount} ${failureLabel} - ${input.totalTokens} tokens - cost ${formatConsoleUsageCost(input.totalCostUsd)} - savings ${formatConsoleUsageCost(input.totalSavingsUsd)}`;
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
    totalSavingsUsd: row.total_savings_usd,
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
    totalSavingsUsd: row.total_savings_usd,
    totalTokens: readInteger(row.total_tokens),
  };
}

function rowToConsoleUsageTrendPoint(row: UsageTrendRow): ConsoleUsageTrendPoint {
  return {
    bucketStart: row.bucket_start instanceof Date ? row.bucket_start : new Date(row.bucket_start),
    inputTokens: readInteger(row.input_tokens),
    outputTokens: readInteger(row.output_tokens),
    requestCount: row.request_count,
    totalCostUsd: row.total_cost_usd,
    totalSavingsUsd: row.total_savings_usd,
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
    agentId?: string | null;
    providerId?: string | null;
    virtualModelId?: string | null;
  },
  range: { end: Date; start: Date },
): { values: unknown[]; whereSql: string } {
  const values: unknown[] = [range.start.toISOString(), range.end.toISOString()];
  const clauses = ["request_activity.started_at >= $1", "request_activity.started_at < $2"];

  if (input.agentId) {
    values.push(input.agentId);
    clauses.push(`request_activity.agent_id = $${values.length}::uuid`);
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
