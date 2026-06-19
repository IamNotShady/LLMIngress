import { Client, type QueryResultRow } from "pg";

export type ConsoleUsageWindow = "24h" | "7d" | "30d";

export type ConsoleUsageBreakdown = {
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
  failureCount: number;
  id: string;
  label: string;
  requestCount: number;
  totalCostUsd: string | null;
  totalSavingsUsd: string | null;
  totalTokens: number;
};

export type ConsoleUsageSummary = {
  agentBreakdowns: ConsoleUsageDimensionBreakdown[];
  breakdowns: ConsoleUsageBreakdown[];
  failureCount: number;
  inputTokens: number;
  modelBreakdowns: ConsoleUsageDimensionBreakdown[];
  outputTokens: number;
  providerBreakdowns: ConsoleUsageDimensionBreakdown[];
  requestCount: number;
  totalCostUsd: string | null;
  totalSavingsUsd: string | null;
  totalTokens: number;
  virtualModelBreakdowns: ConsoleUsageDimensionBreakdown[];
  window: ConsoleUsageWindow;
};

type UsageSummaryRow = QueryResultRow & {
  failure_count: number;
  input_tokens: string | null;
  output_tokens: string | null;
  request_count: number;
  total_cost_usd: string | null;
  total_savings_usd: string | null;
  total_tokens: string | null;
};

type UsageBreakdownRow = QueryResultRow & {
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

type UsageDimensionBreakdownRow = QueryResultRow & {
  failure_count: number;
  id: string | null;
  label: string | null;
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
  databaseUrl: string;
  now?: Date;
  window: ConsoleUsageWindow;
}): Promise<ConsoleUsageSummary> {
  const windowStart = getUsageWindowStart(input.now ?? new Date(), input.window);
  const client = new Client({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    const summaryResult = await client.query<UsageSummaryRow>(
      `
          select count(request_activity.id)::integer as request_count,
                 count(request_activity.id) filter (where request_activity.status = 'failed')::integer
                   as failure_count,
                 coalesce(sum(request_usage.input_tokens), 0)::text as input_tokens,
                 coalesce(sum(request_usage.output_tokens), 0)::text as output_tokens,
                 coalesce(sum(request_usage.total_tokens), 0)::text as total_tokens,
                 coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
                   as total_cost_usd,
                 coalesce(sum(request_savings.savings_usd), 0)::numeric(20, 8)::text
                   as total_savings_usd
          from request_activity
          left join request_usage on request_usage.request_activity_id = request_activity.id
          left join request_costs on request_costs.request_activity_id = request_activity.id
          left join request_savings on request_savings.request_activity_id = request_activity.id
          where request_activity.started_at >= $1
        `,
      [windowStart.toISOString()],
    );
    const breakdownResult = await client.query<UsageBreakdownRow>(
      `
          select request_activity.provider_id::text as provider_id,
                 request_activity.provider_model_id::text as model_id,
                 providers.display_name as provider_label,
                 provider_models.display_name as model_label,
                 count(request_activity.id)::integer as request_count,
                 count(request_activity.id) filter (where request_activity.status = 'failed')::integer
                   as failure_count,
                 coalesce(sum(request_usage.total_tokens), 0)::text as total_tokens,
                 coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
                   as total_cost_usd,
                 coalesce(sum(request_savings.savings_usd), 0)::numeric(20, 8)::text
                   as total_savings_usd
          from request_activity
          left join providers on providers.id = request_activity.provider_id
          left join provider_models on provider_models.id = request_activity.provider_model_id
          left join request_usage on request_usage.request_activity_id = request_activity.id
          left join request_costs on request_costs.request_activity_id = request_activity.id
          left join request_savings on request_savings.request_activity_id = request_activity.id
          where request_activity.started_at >= $1
          group by request_activity.provider_id,
                   request_activity.provider_model_id,
                   providers.display_name,
                   provider_models.display_name
          order by coalesce(sum(request_costs.total_cost_usd), 0) desc,
                   count(request_activity.id) desc,
                   providers.display_name,
                   provider_models.display_name
        `,
      [windowStart.toISOString()],
    );
    const agentBreakdownResult = await client.query<UsageDimensionBreakdownRow>(
      `
          select coalesce(agents.id::text, 'unknown-agent') as id,
                 coalesce(agents.name, 'Unknown agent') as label,
                 count(request_activity.id)::integer as request_count,
                 count(request_activity.id) filter (where request_activity.status = 'failed')::integer
                   as failure_count,
                 coalesce(sum(request_usage.total_tokens), 0)::text as total_tokens,
                 coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
                   as total_cost_usd,
                 coalesce(sum(request_savings.savings_usd), 0)::numeric(20, 8)::text
                   as total_savings_usd
          from request_activity
          left join agents on agents.id = request_activity.agent_id
          left join request_usage on request_usage.request_activity_id = request_activity.id
          left join request_costs on request_costs.request_activity_id = request_activity.id
          left join request_savings on request_savings.request_activity_id = request_activity.id
          where request_activity.started_at >= $1
          group by agents.id,
                   agents.name
          order by min(request_activity.created_at),
                   label
        `,
      [windowStart.toISOString()],
    );
    const virtualModelBreakdownResult = await client.query<UsageDimensionBreakdownRow>(
      `
          select coalesce(request_activity.virtual_model_id::text, 'unknown-virtual-model') as id,
                 case
                   when virtual_models.display_name is not null and virtual_models.name is not null
                     then concat(virtual_models.display_name, ' (', virtual_models.name, ')')
                   when virtual_models.name is not null then virtual_models.name
                   else 'Unknown virtual model'
                 end as label,
                 count(request_activity.id)::integer as request_count,
                 count(request_activity.id) filter (where request_activity.status = 'failed')::integer
                   as failure_count,
                 coalesce(sum(request_usage.total_tokens), 0)::text as total_tokens,
                 coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
                   as total_cost_usd,
                 coalesce(sum(request_savings.savings_usd), 0)::numeric(20, 8)::text
                   as total_savings_usd
          from request_activity
          left join virtual_models on virtual_models.id = request_activity.virtual_model_id
          left join request_usage on request_usage.request_activity_id = request_activity.id
          left join request_costs on request_costs.request_activity_id = request_activity.id
          left join request_savings on request_savings.request_activity_id = request_activity.id
          where request_activity.started_at >= $1
          group by request_activity.virtual_model_id,
                   virtual_models.display_name,
                   virtual_models.name
          order by min(request_activity.created_at),
                   label
        `,
      [windowStart.toISOString()],
    );
    const providerBreakdownResult = await client.query<UsageDimensionBreakdownRow>(
      `
          select coalesce(request_activity.provider_id::text, 'unknown-provider') as id,
                 coalesce(providers.display_name, 'Unknown provider') as label,
                 count(request_activity.id)::integer as request_count,
                 count(request_activity.id) filter (where request_activity.status = 'failed')::integer
                   as failure_count,
                 coalesce(sum(request_usage.total_tokens), 0)::text as total_tokens,
                 coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
                   as total_cost_usd,
                 coalesce(sum(request_savings.savings_usd), 0)::numeric(20, 8)::text
                   as total_savings_usd
          from request_activity
          left join providers on providers.id = request_activity.provider_id
          left join request_usage on request_usage.request_activity_id = request_activity.id
          left join request_costs on request_costs.request_activity_id = request_activity.id
          left join request_savings on request_savings.request_activity_id = request_activity.id
          where request_activity.started_at >= $1
          group by request_activity.provider_id,
                   providers.display_name
          order by min(request_activity.created_at),
                   label
        `,
      [windowStart.toISOString()],
    );
    const modelBreakdownResult = await client.query<UsageDimensionBreakdownRow>(
      `
          select coalesce(request_activity.provider_model_id::text, 'unknown-model') as id,
                 case
                   when provider_models.display_name is not null and provider_models.model_id is not null
                     then concat(provider_models.display_name, ' (', provider_models.model_id, ')')
                   when provider_models.model_id is not null then provider_models.model_id
                   else 'Unknown model'
                 end as label,
                 count(request_activity.id)::integer as request_count,
                 count(request_activity.id) filter (where request_activity.status = 'failed')::integer
                   as failure_count,
                 coalesce(sum(request_usage.total_tokens), 0)::text as total_tokens,
                 coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
                   as total_cost_usd,
                 coalesce(sum(request_savings.savings_usd), 0)::numeric(20, 8)::text
                   as total_savings_usd
          from request_activity
          left join provider_models on provider_models.id = request_activity.provider_model_id
          left join request_usage on request_usage.request_activity_id = request_activity.id
          left join request_costs on request_costs.request_activity_id = request_activity.id
          left join request_savings on request_savings.request_activity_id = request_activity.id
          where request_activity.started_at >= $1
          group by request_activity.provider_model_id,
                   provider_models.display_name,
                   provider_models.model_id
          order by min(request_activity.created_at),
                   label
        `,
      [windowStart.toISOString()],
    );
    const summaryRow = summaryResult.rows[0];

    return {
      agentBreakdowns: agentBreakdownResult.rows.map(rowToConsoleUsageDimensionBreakdown),
      breakdowns: breakdownResult.rows.map(rowToConsoleUsageBreakdown),
      failureCount: summaryRow?.failure_count ?? 0,
      inputTokens: readInteger(summaryRow?.input_tokens),
      modelBreakdowns: modelBreakdownResult.rows.map(rowToConsoleUsageDimensionBreakdown),
      outputTokens: readInteger(summaryRow?.output_tokens),
      providerBreakdowns: providerBreakdownResult.rows.map(rowToConsoleUsageDimensionBreakdown),
      requestCount: summaryRow?.request_count ?? 0,
      totalCostUsd: summaryRow?.total_cost_usd ?? null,
      totalSavingsUsd: summaryRow?.total_savings_usd ?? null,
      totalTokens: readInteger(summaryRow?.total_tokens),
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
    failureCount: row.failure_count,
    id: row.id ?? "unknown",
    label: row.label ?? "Unknown",
    requestCount: row.request_count,
    totalCostUsd: row.total_cost_usd,
    totalSavingsUsd: row.total_savings_usd,
    totalTokens: readInteger(row.total_tokens),
  };
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
