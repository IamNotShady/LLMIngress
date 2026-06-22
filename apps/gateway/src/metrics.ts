import { PostgresClient, type PostgresQueryResultRow } from "@llmingress/db/health";

export const prometheusMetricsContentType = "text/plain; version=0.0.4; charset=utf-8";

export type PrometheusMetricsDocument = {
  body: string;
  contentType: typeof prometheusMetricsContentType;
};

type GetPrometheusMetricsDocumentInput = {
  databaseUrl: string;
};

type GatewayRequestMetricRow = PostgresQueryResultRow & {
  count: number;
  model: string;
  protocol: string;
  provider: string;
  status: string;
};

type GatewayLatencyMetricRow = PostgresQueryResultRow & {
  count: number;
  protocol: string;
  status: string;
  sum_ms: number;
};

type GatewayCostMetricRow = PostgresQueryResultRow & {
  model: string;
  provider: string;
  total_cost_usd: string | null;
};

type GatewayFallbackMetricRow = PostgresQueryResultRow & {
  count: number;
  error_code: string;
  model: string;
  provider: string;
  status: string;
};

type ProviderHealthMetricRow = PostgresQueryResultRow & {
  consecutive_failures: number;
  model: string;
  provider: string;
  status: string;
};

type WorkerJobMetricRow = PostgresQueryResultRow & {
  count: number;
  job_type: string;
  status: string;
  trigger: string;
};

type WorkerJobAttemptMetricRow = PostgresQueryResultRow & {
  count: number;
  job_type: string;
  status: string;
};

export async function getPrometheusMetricsDocument(
  input: GetPrometheusMetricsDocumentInput,
): Promise<PrometheusMetricsDocument> {
  const snapshot = await collectPrometheusMetricsSnapshot(input.databaseUrl);
  return {
    body: renderPrometheusMetrics(snapshot),
    contentType: prometheusMetricsContentType,
  };
}

async function collectPrometheusMetricsSnapshot(databaseUrl: string): Promise<{
  fallbackEvents: GatewayFallbackMetricRow[];
  gatewayCosts: GatewayCostMetricRow[];
  gatewayLatency: GatewayLatencyMetricRow[];
  gatewayRequests: GatewayRequestMetricRow[];
  providerHealth: ProviderHealthMetricRow[];
  workerJobAttempts: WorkerJobAttemptMetricRow[];
  workerJobs: WorkerJobMetricRow[];
}> {
  const client = new PostgresClient({ connectionString: databaseUrl });
  await client.connect();

  try {
    const gatewayRequests = await client.query<GatewayRequestMetricRow>(
      `
        select request_activity.protocol,
               coalesce(request_activity.provider_key_snapshot, providers.provider_key, 'unknown')
                 as provider,
               coalesce(request_activity.provider_model_name_snapshot, provider_models.model_id, 'unknown')
                 as model,
               request_activity.status,
               count(*)::integer as count
        from request_activity
        left join providers on providers.id = request_activity.provider_id
        left join provider_models on provider_models.id = request_activity.provider_model_id
        where request_activity.status in ('succeeded', 'failed', 'canceled')
        group by request_activity.protocol,
                 coalesce(request_activity.provider_key_snapshot, providers.provider_key, 'unknown'),
                 coalesce(
                   request_activity.provider_model_name_snapshot,
                   provider_models.model_id,
                   'unknown'
                 ),
                 request_activity.status
        order by request_activity.protocol,
                 coalesce(request_activity.provider_key_snapshot, providers.provider_key, 'unknown'),
                 coalesce(
                   request_activity.provider_model_name_snapshot,
                   provider_models.model_id,
                   'unknown'
                 ),
                 request_activity.status
      `,
    );
    const gatewayLatency = await client.query<GatewayLatencyMetricRow>(
      `
        select protocol,
               status,
               count(*)::integer as count,
               coalesce(sum(latency_ms), 0)::float8 as sum_ms
        from request_activity
        where latency_ms is not null
        group by protocol, status
        order by protocol, status
      `,
    );
    const gatewayCosts = await client.query<GatewayCostMetricRow>(
      `
        select coalesce(request_activity.provider_key_snapshot, providers.provider_key, 'unknown')
                 as provider,
               coalesce(request_activity.provider_model_name_snapshot, provider_models.model_id, 'unknown')
                 as model,
               coalesce(sum(request_costs.total_cost_usd), 0)::text as total_cost_usd
        from request_costs
        join request_activity on request_activity.id = request_costs.request_activity_id
        left join provider_models on provider_models.id = request_costs.provider_model_id
        left join providers on providers.id = provider_models.provider_id
        where request_costs.total_cost_usd is not null
        group by coalesce(request_activity.provider_key_snapshot, providers.provider_key, 'unknown'),
                 coalesce(
                   request_activity.provider_model_name_snapshot,
                   provider_models.model_id,
                   'unknown'
                 )
        order by coalesce(request_activity.provider_key_snapshot, providers.provider_key, 'unknown'),
                 coalesce(
                   request_activity.provider_model_name_snapshot,
                   provider_models.model_id,
                   'unknown'
                 )
      `,
    );
    const fallbackEvents = await client.query<GatewayFallbackMetricRow>(
      `
        select coalesce(providers.provider_key, 'unknown') as provider,
               coalesce(provider_models.model_id, 'unknown') as model,
               fallback_events.status,
               coalesce(fallback_events.error_code, 'none') as error_code,
               count(*)::integer as count
        from fallback_events
        left join provider_models on provider_models.id = fallback_events.provider_model_id
        left join providers on providers.id = provider_models.provider_id
        group by coalesce(providers.provider_key, 'unknown'),
                 coalesce(provider_models.model_id, 'unknown'),
                 fallback_events.status,
                 coalesce(fallback_events.error_code, 'none')
        order by coalesce(providers.provider_key, 'unknown'),
                 coalesce(provider_models.model_id, 'unknown'),
                 fallback_events.status,
                 coalesce(fallback_events.error_code, 'none')
      `,
    );
    const providerHealth = await client.query<ProviderHealthMetricRow>(
      `
        select providers.provider_key as provider,
               coalesce(provider_models.model_id, 'provider') as model,
               provider_health_summary.status,
               provider_health_summary.consecutive_failures::integer as consecutive_failures
        from provider_health_summary
        join providers on providers.id = provider_health_summary.provider_id
        left join provider_models on provider_models.id = provider_health_summary.provider_model_id
        where providers.deleted_at is null
          and (
            provider_health_summary.provider_model_id is null
            or provider_models.deleted_at is null
          )
        order by providers.provider_key,
                 coalesce(provider_models.model_id, 'provider'),
                 provider_health_summary.status
      `,
    );
    const workerJobs = await client.query<WorkerJobMetricRow>(
      `
        select job_type,
               status,
               trigger,
               count(*)::integer as count
        from jobs
        where status in ('succeeded', 'failed', 'canceled')
        group by job_type, status, trigger
        order by job_type, status, trigger
      `,
    );
    const workerJobAttempts = await client.query<WorkerJobAttemptMetricRow>(
      `
        select jobs.job_type,
               job_attempts.status,
               count(*)::integer as count
        from job_attempts
        join jobs on jobs.id = job_attempts.job_id
        where job_attempts.status in ('succeeded', 'failed')
        group by jobs.job_type, job_attempts.status
        order by jobs.job_type, job_attempts.status
      `,
    );

    return {
      fallbackEvents: fallbackEvents.rows,
      gatewayCosts: gatewayCosts.rows,
      gatewayLatency: gatewayLatency.rows,
      gatewayRequests: gatewayRequests.rows,
      providerHealth: providerHealth.rows,
      workerJobAttempts: workerJobAttempts.rows,
      workerJobs: workerJobs.rows,
    };
  } finally {
    await client.end();
  }
}

function renderPrometheusMetrics(snapshot: {
  fallbackEvents: GatewayFallbackMetricRow[];
  gatewayCosts: GatewayCostMetricRow[];
  gatewayLatency: GatewayLatencyMetricRow[];
  gatewayRequests: GatewayRequestMetricRow[];
  providerHealth: ProviderHealthMetricRow[];
  workerJobAttempts: WorkerJobAttemptMetricRow[];
  workerJobs: WorkerJobMetricRow[];
}): string {
  const lines: string[] = [];

  addMetricHeader(
    lines,
    "llmingress_gateway_requests_total",
    "Gateway requests grouped by protocol, provider, model, and status.",
    "counter",
  );
  for (const row of snapshot.gatewayRequests) {
    lines.push(
      metricLine(
        "llmingress_gateway_requests_total",
        {
          protocol: row.protocol,
          provider: row.provider,
          model: row.model,
          status: row.status,
        },
        row.count,
      ),
    );
  }

  addMetricHeader(
    lines,
    "llmingress_gateway_request_latency_ms",
    "Gateway completed request latency in milliseconds.",
    "summary",
  );
  for (const row of snapshot.gatewayLatency) {
    const labels = {
      protocol: row.protocol,
      status: row.status,
    };
    lines.push(metricLine("llmingress_gateway_request_latency_ms_sum", labels, row.sum_ms));
    lines.push(metricLine("llmingress_gateway_request_latency_ms_count", labels, row.count));
  }

  addMetricHeader(
    lines,
    "llmingress_gateway_request_cost_usd_total",
    "Gateway request cost in USD grouped by provider and model.",
    "counter",
  );
  for (const row of snapshot.gatewayCosts) {
    lines.push(
      metricLine(
        "llmingress_gateway_request_cost_usd_total",
        { provider: row.provider, model: row.model },
        row.total_cost_usd ?? 0,
      ),
    );
  }

  addMetricHeader(
    lines,
    "llmingress_gateway_fallback_events_total",
    "Gateway fallback events grouped by provider, model, status, and error code.",
    "counter",
  );
  for (const row of snapshot.fallbackEvents) {
    lines.push(
      metricLine(
        "llmingress_gateway_fallback_events_total",
        {
          provider: row.provider,
          model: row.model,
          status: row.status,
          error_code: row.error_code,
        },
        row.count,
      ),
    );
  }

  addMetricHeader(
    lines,
    "llmingress_provider_health_status",
    "Provider health summary status as one-hot gauges.",
    "gauge",
  );
  addMetricHeader(
    lines,
    "llmingress_provider_health_consecutive_failures",
    "Provider health consecutive failure count.",
    "gauge",
  );
  for (const row of snapshot.providerHealth) {
    const labels = {
      provider: row.provider,
      model: row.model,
      status: row.status,
    };
    lines.push(metricLine("llmingress_provider_health_status", labels, 1));
    lines.push(
      metricLine(
        "llmingress_provider_health_consecutive_failures",
        { provider: row.provider, model: row.model },
        row.consecutive_failures,
      ),
    );
  }

  addMetricHeader(
    lines,
    "llmingress_worker_jobs_total",
    "Worker jobs grouped by job type, status, and trigger.",
    "counter",
  );
  for (const row of snapshot.workerJobs) {
    lines.push(
      metricLine(
        "llmingress_worker_jobs_total",
        {
          job_type: row.job_type,
          status: row.status,
          trigger: row.trigger,
        },
        row.count,
      ),
    );
  }

  addMetricHeader(
    lines,
    "llmingress_worker_job_attempts_total",
    "Worker job attempts grouped by job type and status.",
    "counter",
  );
  for (const row of snapshot.workerJobAttempts) {
    lines.push(
      metricLine(
        "llmingress_worker_job_attempts_total",
        {
          job_type: row.job_type,
          status: row.status,
        },
        row.count,
      ),
    );
  }

  return `${lines.join("\n")}\n`;
}

function addMetricHeader(lines: string[], name: string, help: string, type: string): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);
}

function metricLine(name: string, labels: Record<string, string>, value: number | string): string {
  const renderedLabels = Object.entries(labels)
    .map(([key, labelValue]) => `${key}="${escapePrometheusLabelValue(labelValue)}"`)
    .join(",");
  return `${name}{${renderedLabels}} ${formatPrometheusNumber(value)}`;
}

function escapePrometheusLabelValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function formatPrometheusNumber(value: number | string): string {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return "0";
  }
  return String(numeric);
}
