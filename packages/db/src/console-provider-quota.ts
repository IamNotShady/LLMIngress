import { withPooledPostgresClient } from "@llmingress/db/client";
import type { ProviderQuotaErrorCode, QuotaEntry } from "@llmingress/domain/quota";

export type ConsoleProviderQuotaSummary = {
  connectionKind: "api_key" | "local" | "oauth";
  connectionLabel: string;
  entries: QuotaEntry[];
  errorCode: ProviderQuotaErrorCode | null;
  id: string;
  observedAt: Date | null;
  // False when the connection or its Provider is disabled, or quota probing is
  // switched off — the enqueue scan skips it, so any stored row only ages.
  probingEnabled: boolean;
  // The connection's own probe switch, independent of enabled state; this is
  // what the Console toggle reads and flips.
  quotaProbeEnabled: boolean;
  providerDisplayName: string;
  providerId: string;
  providerKey: string;
};

export type ListConsoleProviderQuotaSummariesInput = {
  databaseUrl?: string;
};

type ProviderConnectionQuotaRow = {
  connection_kind: ConsoleProviderQuotaSummary["connectionKind"];
  connection_label: string;
  entries: QuotaEntry[] | null;
  error_code: ProviderQuotaErrorCode | null;
  id: string;
  observed_at: Date | null;
  probing_enabled: boolean;
  provider_display_name: string;
  quota_probe_enabled: boolean;
  provider_id: string;
  provider_key: string;
};

export async function listConsoleProviderQuotaSummaries(
  input: ListConsoleProviderQuotaSummariesInput = {},
): Promise<ConsoleProviderQuotaSummary[]> {
  return withPooledPostgresClient(input.databaseUrl, async (client) => {
    const connections = await client.query<ProviderConnectionQuotaRow>(
      `
        with provider_connections as (
          select providers.id,
                 providers.id as provider_id,
                 providers.provider_key,
                 providers.display_name as provider_display_name,
                 'local'::text as connection_kind,
                 'Local connection'::text as connection_label,
                 providers.enabled as probing_enabled,
                 true as quota_probe_enabled
          from providers
          where providers.provider_type = 'local'
            and providers.deleted_at is null

          union all

          select provider_api_keys.id,
                 providers.id as provider_id,
                 providers.provider_key,
                 providers.display_name as provider_display_name,
                 'api_key'::text as connection_kind,
                 coalesce(provider_api_keys.label, provider_api_keys.key_prefix) as connection_label,
                 (providers.enabled
                   and provider_api_keys.enabled
                   and provider_api_keys.quota_probe_enabled) as probing_enabled,
                 provider_api_keys.quota_probe_enabled
          from provider_api_keys
          join providers on providers.id = provider_api_keys.provider_id
          where provider_api_keys.deleted_at is null
            and providers.deleted_at is null

          union all

          select provider_oauth.id,
                 providers.id as provider_id,
                 providers.provider_key,
                 providers.display_name as provider_display_name,
                 'oauth'::text as connection_kind,
                 coalesce(provider_oauth.label, 'OAuth connection') as connection_label,
                 (providers.enabled
                   and provider_oauth.enabled
                   and provider_oauth.quota_probe_enabled) as probing_enabled,
                 provider_oauth.quota_probe_enabled
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
               provider_connections.connection_kind,
               provider_connections.connection_label,
               provider_connections.probing_enabled,
               provider_connections.quota_probe_enabled,
               provider_quota_summary.entries,
               provider_quota_summary.error_code,
               provider_quota_summary.observed_at
        from provider_connections
        left join provider_quota_summary
          on provider_quota_summary.provider_id = provider_connections.provider_id
         and provider_quota_summary.provider_connection_id = provider_connections.id
        order by provider_connections.provider_key,
                 provider_connections.connection_kind,
                 provider_connections.connection_label,
                 provider_connections.id
      `,
    );
    return connections.rows.map((row) => ({
      connectionKind: row.connection_kind,
      connectionLabel: row.connection_label,
      // A missing row means never observed, so the empty array here is a
      // read-model default rather than an observed "no quota" result.
      entries: Array.isArray(row.entries) ? row.entries : [],
      errorCode: row.error_code,
      id: row.id,
      observedAt: row.observed_at ? new Date(row.observed_at) : null,
      probingEnabled: row.probing_enabled,
      providerDisplayName: row.provider_display_name,
      quotaProbeEnabled: row.quota_probe_enabled,
      providerId: row.provider_id,
      providerKey: row.provider_key,
    }));
  });
}
