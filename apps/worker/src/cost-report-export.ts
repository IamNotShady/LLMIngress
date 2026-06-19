import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Client, type QueryResultRow } from "pg";
import { type JobHandler, JobHandlerError } from "./job-runner.js";

export type CostReportWindow = "24h" | "7d" | "30d";

export type CostReportUsageBreakdown = {
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

export type CostReportUsageDimensionBreakdown = {
  failureCount: number;
  id: string;
  label: string;
  requestCount: number;
  totalCostUsd: string | null;
  totalSavingsUsd: string | null;
  totalTokens: number;
};

export type CostReportUsageSummary = {
  agentBreakdowns: CostReportUsageDimensionBreakdown[];
  breakdowns: CostReportUsageBreakdown[];
  failureCount: number;
  inputTokens: number;
  modelBreakdowns: CostReportUsageDimensionBreakdown[];
  outputTokens: number;
  providerBreakdowns: CostReportUsageDimensionBreakdown[];
  requestCount: number;
  totalCostUsd: string | null;
  totalSavingsUsd: string | null;
  totalTokens: number;
  virtualModelBreakdowns: CostReportUsageDimensionBreakdown[];
  window: CostReportWindow;
};

export type CostReportExportDocument = {
  breakdowns: {
    agents: CostReportUsageDimensionBreakdown[];
    models: CostReportUsageDimensionBreakdown[];
    providerModels: CostReportUsageBreakdown[];
    providers: CostReportUsageDimensionBreakdown[];
    virtualModels: CostReportUsageDimensionBreakdown[];
  };
  exportType: "cost_report";
  generatedAt: string;
  summary: {
    failureCount: number;
    inputTokens: number;
    outputTokens: number;
    requestCount: number;
    totalCostUsd: string | null;
    totalSavingsUsd: string | null;
    totalTokens: number;
  };
  window: {
    end: string;
    label: CostReportWindow;
    start: string;
  };
};

export type CostReportExportJobHandlerOptions = {
  databaseUrl: string;
  now?: () => Date;
};

type NormalizedCostReportPayload = {
  outputPath: string;
  window: CostReportWindow;
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

const exportType = "cost_report";

export function createCostReportExportJobHandler(
  options: CostReportExportJobHandlerOptions,
): JobHandler {
  const now = options.now ?? (() => new Date());

  return async (job) => {
    const generatedAt = now();
    const payload = normalizeCostReportPayload(job.payload);
    const windowStart = getUsageWindowStart(generatedAt, payload.window);
    const client = new Client({ connectionString: options.databaseUrl });
    await client.connect();

    try {
      const usageSummary = await getCostReportUsageSummary({
        client,
        window: payload.window,
        windowStart,
      });
      const report = buildCostReportExportDocument({
        generatedAt,
        usageSummary,
        windowStart,
      });
      await writeCostReportFile(payload.outputPath, report);

      const exportTaskId = await insertSucceededExportTask(client, {
        completedAt: generatedAt,
        jobId: job.id,
        outputPath: payload.outputPath,
        requestCount: report.summary.requestCount,
        startedAt: generatedAt,
        totalCostUsd: report.summary.totalCostUsd,
        window: payload.window,
      });

      return {
        exportTaskId,
        exportType,
        outputPath: payload.outputPath,
        requestCount: report.summary.requestCount,
        totalCostUsd: report.summary.totalCostUsd,
        trigger: job.trigger,
        window: payload.window,
      };
    } finally {
      await client.end();
    }
  };
}

export function buildCostReportExportDocument(input: {
  generatedAt: Date;
  usageSummary: CostReportUsageSummary;
  windowStart: Date;
}): CostReportExportDocument {
  return {
    breakdowns: {
      agents: input.usageSummary.agentBreakdowns,
      models: input.usageSummary.modelBreakdowns,
      providerModels: input.usageSummary.breakdowns,
      providers: input.usageSummary.providerBreakdowns,
      virtualModels: input.usageSummary.virtualModelBreakdowns,
    },
    exportType,
    generatedAt: input.generatedAt.toISOString(),
    summary: {
      failureCount: input.usageSummary.failureCount,
      inputTokens: input.usageSummary.inputTokens,
      outputTokens: input.usageSummary.outputTokens,
      requestCount: input.usageSummary.requestCount,
      totalCostUsd: input.usageSummary.totalCostUsd,
      totalSavingsUsd: input.usageSummary.totalSavingsUsd,
      totalTokens: input.usageSummary.totalTokens,
    },
    window: {
      end: input.generatedAt.toISOString(),
      label: input.usageSummary.window,
      start: input.windowStart.toISOString(),
    },
  };
}

function normalizeCostReportPayload(rawPayload: unknown): NormalizedCostReportPayload {
  const payload = readObject(rawPayload);
  return {
    outputPath: resolve(readRequiredString(payload.outputPath, "outputPath")),
    window: readCostReportWindow(payload.window),
  };
}

async function getCostReportUsageSummary(input: {
  client: Client;
  window: CostReportWindow;
  windowStart: Date;
}): Promise<CostReportUsageSummary> {
  const summaryResult = await input.client.query<UsageSummaryRow>(
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
    [input.windowStart.toISOString()],
  );
  const breakdownResult = await input.client.query<UsageBreakdownRow>(
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
    [input.windowStart.toISOString()],
  );
  const agentBreakdownResult = await input.client.query<UsageDimensionBreakdownRow>(
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
    [input.windowStart.toISOString()],
  );
  const virtualModelBreakdownResult = await input.client.query<UsageDimensionBreakdownRow>(
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
    [input.windowStart.toISOString()],
  );
  const providerBreakdownResult = await input.client.query<UsageDimensionBreakdownRow>(
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
    [input.windowStart.toISOString()],
  );
  const modelBreakdownResult = await input.client.query<UsageDimensionBreakdownRow>(
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
    [input.windowStart.toISOString()],
  );
  const summaryRow = summaryResult.rows[0];

  return {
    agentBreakdowns: agentBreakdownResult.rows.map(rowToCostReportUsageDimensionBreakdown),
    breakdowns: breakdownResult.rows.map(rowToCostReportUsageBreakdown),
    failureCount: summaryRow?.failure_count ?? 0,
    inputTokens: readInteger(summaryRow?.input_tokens),
    modelBreakdowns: modelBreakdownResult.rows.map(rowToCostReportUsageDimensionBreakdown),
    outputTokens: readInteger(summaryRow?.output_tokens),
    providerBreakdowns: providerBreakdownResult.rows.map(rowToCostReportUsageDimensionBreakdown),
    requestCount: summaryRow?.request_count ?? 0,
    totalCostUsd: summaryRow?.total_cost_usd ?? null,
    totalSavingsUsd: summaryRow?.total_savings_usd ?? null,
    totalTokens: readInteger(summaryRow?.total_tokens),
    virtualModelBreakdowns: virtualModelBreakdownResult.rows.map(
      rowToCostReportUsageDimensionBreakdown,
    ),
    window: input.window,
  };
}

async function writeCostReportFile(
  outputPath: string,
  report: CostReportExportDocument,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function insertSucceededExportTask(
  client: Client,
  input: {
    completedAt: Date;
    jobId: string;
    outputPath: string;
    requestCount: number;
    startedAt: Date;
    totalCostUsd: string | null;
    window: CostReportWindow;
  },
): Promise<string> {
  const exportTaskId = randomUUID();
  const result = await client.query<{ id: string }>(
    `
      insert into export_tasks (
        id,
        job_id,
        export_type,
        status,
        output_path,
        line_count,
        started_at,
        completed_at,
        metadata,
        updated_at
      )
      values ($1, $2, $3, 'succeeded', $4, 1, $5::timestamptz, $6::timestamptz, $7::jsonb, $6::timestamptz)
      on conflict (job_id)
      do update set
        status = excluded.status,
        output_path = excluded.output_path,
        line_count = excluded.line_count,
        error_code = null,
        error_message = null,
        metadata = excluded.metadata,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at
      returning id::text
    `,
    [
      exportTaskId,
      input.jobId,
      exportType,
      input.outputPath,
      input.startedAt.toISOString(),
      input.completedAt.toISOString(),
      JSON.stringify({
        requestCount: input.requestCount,
        totalCostUsd: input.totalCostUsd,
        window: input.window,
      }),
    ],
  );

  return result.rows[0]?.id ?? exportTaskId;
}

function rowToCostReportUsageBreakdown(row: UsageBreakdownRow): CostReportUsageBreakdown {
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

function rowToCostReportUsageDimensionBreakdown(
  row: UsageDimensionBreakdownRow,
): CostReportUsageDimensionBreakdown {
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

function getUsageWindowStart(now: Date, window: CostReportWindow): Date {
  const durationMs = {
    "24h": 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
  }[window];

  return new Date(now.getTime() - durationMs);
}

function readCostReportWindow(value: unknown): CostReportWindow {
  if (value === undefined || value === null || value === "") {
    return "24h";
  }
  if (value === "24h" || value === "7d" || value === "30d") {
    return value;
  }
  throw new JobHandlerError(
    "cost_report_export_invalid_payload",
    "Cost report export payload window must be one of 24h, 7d, or 30d.",
  );
}

function readInteger(value: string | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
      "cost_report_export_invalid_payload",
      `Cost report export payload ${fieldName} is required.`,
    );
  }
  return value.trim();
}
