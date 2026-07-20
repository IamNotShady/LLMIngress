import { randomUUID } from "node:crypto";
import { type PostgresQueryClient, withPostgresTransaction } from "@llmingress/db/client";
import type { ProviderQuotaErrorCode, QuotaEntry } from "@llmingress/domain/quota";

export type RecordProviderQuotaInput = {
  databaseUrl?: string;
  entries: QuotaEntry[];
  errorCode?: ProviderQuotaErrorCode | null;
  nextRefreshAt?: Date | null;
  observedAt?: Date;
  providerConnectionId: string;
  providerId: string;
};

export async function recordProviderQuota(input: RecordProviderQuotaInput): Promise<void> {
  return withPostgresTransaction(input.databaseUrl, (client) =>
    recordProviderQuotaWithClient(client, input),
  );
}

/**
 * Unlike provider health, a row is written even when nothing could be read:
 * a missing row means "never observed", which Console must be able to tell
 * apart from "observed and unavailable".
 */
export async function recordProviderQuotaWithClient(
  client: PostgresQueryClient,
  input: Omit<RecordProviderQuotaInput, "databaseUrl">,
): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `provider_quota:${input.providerId}:${input.providerConnectionId}`,
  ]);
  const observedAt = input.observedAt ?? new Date();
  // Update-first: the routine refresh touches only the summary row and never
  // locks the credential tables, so it cannot contend with Console edits.
  const updated = await client.query(
    `
      update provider_quota_summary
      set entries = $3::jsonb,
          observed_at = $4,
          next_refresh_at = $5,
          error_code = $6,
          updated_at = $4
      where provider_id = $1
        and provider_connection_id = $2
    `,
    [
      input.providerId,
      input.providerConnectionId,
      JSON.stringify(input.entries),
      observedAt,
      input.nextRefreshAt ?? null,
      input.errorCode ?? null,
    ],
  );
  if ((updated.rowCount ?? 0) > 0) {
    return;
  }

  // A miss is either the connection's first observation or a deletion that
  // cleared the row while this probe was in flight. Inserting blindly would
  // resurrect the cleared row as a permanent orphan the enqueue scan never
  // revisits, so insert only for a live credential. The row lock makes a
  // concurrent soft-delete wait until this commit, so its clear still wins.
  if (!(await lockLiveConnectionRow(client, input))) {
    return;
  }
  await client.query(
    `
      insert into provider_quota_summary (
        id,
        provider_id,
        provider_connection_id,
        entries,
        observed_at,
        next_refresh_at,
        error_code,
        updated_at
      )
      values ($1, $2, $3, $4::jsonb, $5, $6, $7, $5)
    `,
    [
      randomUUID(),
      input.providerId,
      input.providerConnectionId,
      JSON.stringify(input.entries),
      observedAt,
      input.nextRefreshAt ?? null,
      input.errorCode ?? null,
    ],
  );
}

async function lockLiveConnectionRow(
  client: PostgresQueryClient,
  input: { providerConnectionId: string; providerId: string },
): Promise<boolean> {
  const apiKey = await client.query(
    `
      select id
      from provider_api_keys
      where id = $2
        and provider_id = $1
        and deleted_at is null
      for update
    `,
    [input.providerId, input.providerConnectionId],
  );
  if (apiKey.rows.length > 0) {
    return true;
  }
  const oauth = await client.query(
    `
      select id
      from provider_oauth
      where id = $2
        and provider_id = $1
        and deleted_at is null
      for update
    `,
    [input.providerId, input.providerConnectionId],
  );
  if (oauth.rows.length > 0) {
    return true;
  }
  const local = await client.query(
    `
      select id
      from providers
      where id = $1
        and id = $2
        and deleted_at is null
      for update
    `,
    [input.providerId, input.providerConnectionId],
  );
  return local.rows.length > 0;
}

export async function clearProviderQuotaWithClient(
  client: PostgresQueryClient,
  input: { providerConnectionId: string; providerId: string },
): Promise<void> {
  await client.query(
    `
      delete from provider_quota_summary
      where provider_id = $1
        and provider_connection_id = $2
    `,
    [input.providerId, input.providerConnectionId],
  );
}

/** Providers that will never report are backed off a day rather than retried every cycle. */
export function providerQuotaRefreshDelayMs(errorCode: ProviderQuotaErrorCode | null): number {
  if (errorCode === "not_supported" || errorCode === "requires_separate_credential") {
    return 24 * 60 * 60_000;
  }
  if (errorCode === "unauthorized") {
    return 60 * 60_000;
  }
  return 15 * 60_000;
}
