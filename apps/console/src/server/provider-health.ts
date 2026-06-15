import { Client, type QueryResultRow } from "pg";

export type ConsoleProviderHealthStatus = "degraded" | "healthy" | "unknown" | "unhealthy";
export type ConsoleProviderHealthTrigger = "manual" | "request_path" | "worker_probe";

export type ConsoleProviderModelHealthSummary = {
  consecutiveFailures: number;
  displayName: string;
  id: string;
  isStale: boolean;
  latestProbeAt: Date | null;
  modelId: string;
  providerId: string;
  status: ConsoleProviderHealthStatus;
  trigger: ConsoleProviderHealthTrigger | null;
};

export type ConsoleProviderHealthSummary = {
  consecutiveFailures: number;
  displayName: string;
  id: string;
  isStale: boolean;
  latestProbeAt: Date | null;
  models: ConsoleProviderModelHealthSummary[];
  providerKey: string;
  status: ConsoleProviderHealthStatus;
  trigger: ConsoleProviderHealthTrigger | null;
};

export type ListConsoleProviderHealthSummariesInput = {
  databaseUrl: string;
  now?: Date;
  staleAfterMs?: number;
};

type ProviderHealthSummaryRow = QueryResultRow & {
  consecutive_failures: number | null;
  display_name: string;
  id: string;
  latest_probe_at: Date | null;
  provider_key: string;
  status: ConsoleProviderHealthStatus | null;
  trigger: ConsoleProviderHealthTrigger | null;
};

type ProviderModelHealthSummaryRow = QueryResultRow & {
  consecutive_failures: number | null;
  display_name: string;
  id: string;
  latest_probe_at: Date | null;
  model_id: string;
  provider_id: string;
  status: ConsoleProviderHealthStatus | null;
  trigger: ConsoleProviderHealthTrigger | null;
};

const defaultHealthStaleAfterMs = 5 * 60 * 1000;

export async function listConsoleProviderHealthSummaries(
  input: ListConsoleProviderHealthSummariesInput,
): Promise<ConsoleProviderHealthSummary[]> {
  const client = new Client({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    const [providerResult, modelResult] = await Promise.all([
      client.query<ProviderHealthSummaryRow>(
        `
          select providers.id::text,
                 providers.provider_key,
                 providers.display_name,
                 provider_health_summary.status,
                 provider_health_summary.consecutive_failures,
                 provider_health_events.observed_at as latest_probe_at,
                 provider_health_events.trigger
          from providers
          left join provider_health_summary
            on provider_health_summary.provider_id = providers.id
           and provider_health_summary.provider_model_id is null
          left join provider_health_events
            on provider_health_events.id = provider_health_summary.last_event_id
          order by providers.provider_key
        `,
      ),
      client.query<ProviderModelHealthSummaryRow>(
        `
          select provider_models.id::text,
                 provider_models.provider_id::text,
                 provider_models.model_id,
                 provider_models.display_name,
                 provider_health_summary.status,
                 provider_health_summary.consecutive_failures,
                 provider_health_events.observed_at as latest_probe_at,
                 provider_health_events.trigger
          from provider_models
          join providers on providers.id = provider_models.provider_id
          left join provider_health_summary
            on provider_health_summary.provider_id = providers.id
           and provider_health_summary.provider_model_id = provider_models.id
          left join provider_health_events
            on provider_health_events.id = provider_health_summary.last_event_id
          order by providers.provider_key,
                   provider_models.display_name
        `,
      ),
    ]);
    const now = input.now ?? new Date();
    const staleAfterMs = input.staleAfterMs ?? defaultHealthStaleAfterMs;
    const modelsByProviderId = groupModelsByProviderId(
      modelResult.rows.map((row) =>
        rowToProviderModelHealthSummary(row, {
          now,
          staleAfterMs,
        }),
      ),
    );

    return providerResult.rows.map((row) =>
      rowToProviderHealthSummary(row, {
        models: modelsByProviderId.get(row.id) ?? [],
        now,
        staleAfterMs,
      }),
    );
  } finally {
    await client.end();
  }
}

export function formatProviderHealthStatus(
  status: ConsoleProviderHealthStatus | null | undefined,
): string {
  if (!status) {
    return "Unknown";
  }

  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function formatProviderHealthLatestProbe(input: {
  latestProbeAt: Date | null;
  trigger: ConsoleProviderHealthTrigger | null;
}): string {
  if (!input.latestProbeAt) {
    return "Latest probe: Never";
  }

  return `Latest probe: ${input.latestProbeAt.toISOString()} via ${input.trigger ?? "unknown"}`;
}

export function formatProviderHealthFailureCount(consecutiveFailures: number): string {
  return `Consecutive failures: ${consecutiveFailures}`;
}

export function formatProviderHealthStaleStatus(input: {
  latestProbeAt: Date | null;
  now?: Date;
  staleAfterMs?: number;
}): string {
  if (!input.latestProbeAt) {
    return "No probe";
  }

  const now = input.now ?? new Date();
  const staleAfterMs = input.staleAfterMs ?? defaultHealthStaleAfterMs;
  const ageMs = now.getTime() - input.latestProbeAt.getTime();
  return ageMs <= staleAfterMs ? "Fresh" : "Stale";
}

function rowToProviderHealthSummary(
  row: ProviderHealthSummaryRow,
  input: {
    models: ConsoleProviderModelHealthSummary[];
    now: Date;
    staleAfterMs: number;
  },
): ConsoleProviderHealthSummary {
  const latestProbeAt = row.latest_probe_at;
  return {
    consecutiveFailures: row.consecutive_failures ?? 0,
    displayName: row.display_name,
    id: row.id,
    isStale:
      formatProviderHealthStaleStatus({
        latestProbeAt,
        now: input.now,
        staleAfterMs: input.staleAfterMs,
      }) !== "Fresh",
    latestProbeAt,
    models: input.models,
    providerKey: row.provider_key,
    status: row.status ?? "unknown",
    trigger: row.trigger,
  };
}

function rowToProviderModelHealthSummary(
  row: ProviderModelHealthSummaryRow,
  input: {
    now: Date;
    staleAfterMs: number;
  },
): ConsoleProviderModelHealthSummary {
  const latestProbeAt = row.latest_probe_at;
  return {
    consecutiveFailures: row.consecutive_failures ?? 0,
    displayName: row.display_name,
    id: row.id,
    isStale:
      formatProviderHealthStaleStatus({
        latestProbeAt,
        now: input.now,
        staleAfterMs: input.staleAfterMs,
      }) !== "Fresh",
    latestProbeAt,
    modelId: row.model_id,
    providerId: row.provider_id,
    status: row.status ?? "unknown",
    trigger: row.trigger,
  };
}

function groupModelsByProviderId(
  models: ConsoleProviderModelHealthSummary[],
): Map<string, ConsoleProviderModelHealthSummary[]> {
  const modelsByProviderId = new Map<string, ConsoleProviderModelHealthSummary[]>();
  for (const model of models) {
    const modelsForProvider = modelsByProviderId.get(model.providerId) ?? [];
    modelsForProvider.push(model);
    modelsByProviderId.set(model.providerId, modelsForProvider);
  }
  return modelsByProviderId;
}
