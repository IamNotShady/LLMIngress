import { Client, type QueryResultRow } from "pg";

export type ConsoleUsageWindow = "24h" | "7d" | "30d";

export type ConsoleUsageBreakdown = {
  modelId: string;
  modelLabel: string;
  providerId: string;
  providerLabel: string;
  requestCount: number;
  totalCostUsd: string | null;
  totalTokens: number;
};

export type ConsoleUsageSummary = {
  breakdowns: ConsoleUsageBreakdown[];
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  totalCostUsd: string | null;
  totalTokens: number;
  window: ConsoleUsageWindow;
};

type UsageSummaryRow = QueryResultRow & {
  input_tokens: string | null;
  output_tokens: string | null;
  request_count: number;
  total_cost_usd: string | null;
  total_tokens: string | null;
};

type UsageBreakdownRow = QueryResultRow & {
  model_id: string | null;
  model_label: string | null;
  provider_id: string | null;
  provider_label: string | null;
  request_count: number;
  total_cost_usd: string | null;
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
    const [summaryResult, breakdownResult] = await Promise.all([
      client.query<UsageSummaryRow>(
        `
          select count(request_activity.id)::integer as request_count,
                 coalesce(sum(request_usage.input_tokens), 0)::text as input_tokens,
                 coalesce(sum(request_usage.output_tokens), 0)::text as output_tokens,
                 coalesce(sum(request_usage.total_tokens), 0)::text as total_tokens,
                 coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
                   as total_cost_usd
          from request_activity
          left join request_usage on request_usage.request_activity_id = request_activity.id
          left join request_costs on request_costs.request_activity_id = request_activity.id
          where request_activity.started_at >= $1
        `,
        [windowStart.toISOString()],
      ),
      client.query<UsageBreakdownRow>(
        `
          select request_activity.provider_id::text as provider_id,
                 request_activity.provider_model_id::text as model_id,
                 providers.display_name as provider_label,
                 provider_models.display_name as model_label,
                 count(request_activity.id)::integer as request_count,
                 coalesce(sum(request_usage.total_tokens), 0)::text as total_tokens,
                 coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
                   as total_cost_usd
          from request_activity
          left join providers on providers.id = request_activity.provider_id
          left join provider_models on provider_models.id = request_activity.provider_model_id
          left join request_usage on request_usage.request_activity_id = request_activity.id
          left join request_costs on request_costs.request_activity_id = request_activity.id
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
      ),
    ]);
    const summaryRow = summaryResult.rows[0];

    return {
      breakdowns: breakdownResult.rows.map(rowToConsoleUsageBreakdown),
      inputTokens: readInteger(summaryRow?.input_tokens),
      outputTokens: readInteger(summaryRow?.output_tokens),
      requestCount: summaryRow?.request_count ?? 0,
      totalCostUsd: summaryRow?.total_cost_usd ?? null,
      totalTokens: readInteger(summaryRow?.total_tokens),
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

function rowToConsoleUsageBreakdown(row: UsageBreakdownRow): ConsoleUsageBreakdown {
  return {
    modelId: row.model_id ?? "unknown-model",
    modelLabel: row.model_label ?? "Unknown model",
    providerId: row.provider_id ?? "unknown-provider",
    providerLabel: row.provider_label ?? "Unknown provider",
    requestCount: row.request_count,
    totalCostUsd: row.total_cost_usd,
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
