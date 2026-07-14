import { withPooledPostgresClient } from "@llmingress/db/client";

export type ConsoleProviderConnectionHealthStatus =
  | "checking"
  | "disabled"
  | "healthy"
  | "unhealthy";
export type ConsoleProviderHealthTrigger = "manual" | "worker_probe";

export type ConsoleProviderHealthSummary = {
  connectionKind: "api_key" | "local" | "oauth";
  connectionLabel: string;
  consecutiveFailures: number;
  enabled: boolean;
  id: string;
  latestProbeAt: Date | null;
  nextProbeAt: Date | null;
  providerDisplayName: string;
  providerId: string;
  providerKey: string;
  reasonCode: string | null;
  reasonMessage: string | null;
  status: ConsoleProviderConnectionHealthStatus;
  trigger: ConsoleProviderHealthTrigger | null;
};

export type ListConsoleProviderHealthSummariesInput = {
  databaseUrl?: string;
};

type ProviderConnectionHealthRow = {
  connection_kind: ConsoleProviderHealthSummary["connectionKind"];
  connection_label: string;
  consecutive_failures: number | null;
  enabled: boolean;
  id: string;
  latest_probe_at: Date | null;
  next_probe_at: Date | null;
  provider_display_name: string;
  provider_id: string;
  provider_key: string;
  reason_code: string | null;
  reason_message: string | null;
  status: "unhealthy" | null;
  trigger: ConsoleProviderHealthTrigger | null;
};

export async function listConsoleProviderHealthSummaries(
  input: ListConsoleProviderHealthSummariesInput = {},
): Promise<ConsoleProviderHealthSummary[]> {
  return withPooledPostgresClient(input.databaseUrl, async (client) => {
    const [connections, activeJobs] = await Promise.all([
      client.query<ProviderConnectionHealthRow>(
        `
          with provider_connections as (
            select providers.id,
                   providers.id as provider_id,
                   providers.provider_key,
                   providers.display_name as provider_display_name,
                   providers.enabled,
                   'local'::text as connection_kind,
                   'Local connection'::text as connection_label
            from providers
            where providers.provider_type = 'local'
              and providers.deleted_at is null

            union all

            select provider_api_keys.id,
                   providers.id as provider_id,
                   providers.provider_key,
                   providers.display_name as provider_display_name,
                   providers.enabled and provider_api_keys.enabled as enabled,
                   'api_key'::text as connection_kind,
                   coalesce(provider_api_keys.label, provider_api_keys.key_prefix) as connection_label
            from provider_api_keys
            join providers on providers.id = provider_api_keys.provider_id
            where provider_api_keys.deleted_at is null
              and providers.deleted_at is null

            union all

            select provider_oauth.id,
                   providers.id as provider_id,
                   providers.provider_key,
                   providers.display_name as provider_display_name,
                   providers.enabled and provider_oauth.enabled as enabled,
                   'oauth'::text as connection_kind,
                   coalesce(provider_oauth.label, 'OAuth connection') as connection_label
            from provider_oauth
            join providers on providers.id = provider_oauth.provider_id
            where provider_oauth.deleted_at is null
              and provider_oauth.completed_at is not null
              and provider_oauth.encrypted_token is not null
              and providers.deleted_at is null
          )
          select provider_connections.id::text,
                 provider_connections.provider_id::text,
                 provider_connections.provider_key,
                 provider_connections.provider_display_name,
                 provider_connections.enabled,
                 provider_connections.connection_kind,
                 provider_connections.connection_label,
                 provider_health_summary.status,
                 provider_health_summary.consecutive_failures,
                 provider_health_summary.reason_code,
                 provider_health_summary.reason_message,
                 provider_health_summary.next_probe_at,
                 latest_event.observed_at as latest_probe_at,
                 latest_event.trigger
          from provider_connections
          left join provider_health_summary
            on provider_health_summary.provider_id = provider_connections.provider_id
           and provider_health_summary.provider_connection_id = provider_connections.id
          left join lateral (
            select observed_at, trigger
            from provider_health_events
            where provider_health_events.provider_id = provider_connections.provider_id
              and provider_health_events.provider_connection_id = provider_connections.id
            order by observed_at desc, id desc
            limit 1
          ) as latest_event on true
          order by provider_connections.provider_key,
                   provider_connections.connection_kind,
                   provider_connections.connection_label,
                   provider_connections.id
        `,
      ),
      client.query<{ provider_connection_id: string; provider_id: string }>(
        `
          select distinct payload ->> 'providerId' as provider_id,
                          payload ->> 'providerConnectionId' as provider_connection_id
          from jobs
          where job_type = 'provider_connection_probe'
            and status in ('pending', 'running')
            and (status = 'running' or run_after <= now())
            and payload ->> 'providerId' is not null
            and payload ->> 'providerConnectionId' is not null
        `,
      ),
    ]);
    const checking = new Set(
      activeJobs.rows.map((row) => `${row.provider_id}:${row.provider_connection_id}`),
    );
    return connections.rows.map((row) => ({
      connectionKind: row.connection_kind,
      connectionLabel: row.connection_label,
      consecutiveFailures: row.consecutive_failures ?? 0,
      enabled: row.enabled,
      id: row.id,
      latestProbeAt: row.latest_probe_at ? new Date(row.latest_probe_at) : null,
      nextProbeAt: row.next_probe_at ? new Date(row.next_probe_at) : null,
      providerDisplayName: row.provider_display_name,
      providerId: row.provider_id,
      providerKey: row.provider_key,
      reasonCode: row.reason_code,
      reasonMessage: row.reason_message,
      status: !row.enabled
        ? "disabled"
        : checking.has(`${row.provider_id}:${row.id}`)
          ? "checking"
          : (row.status ?? "healthy"),
      trigger: row.trigger,
    }));
  });
}
