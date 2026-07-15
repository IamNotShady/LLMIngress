import { randomUUID } from "node:crypto";
import { type PostgresQueryClient, withPostgresTransaction } from "@llmingress/db/client";
import { consoleNotFoundError, consoleValidationError } from "./console-operation-error.ts";
import { clearProviderConnectionHealthWithClient } from "./provider-health.ts";

export type ProviderModelRefreshInput = {
  providerId?: string | null;
};

export type ProviderConnectionProbeSource =
  | "api_key_saved"
  | "base_url_changed"
  | "gateway_credential_error"
  | "manual_probe"
  | "oauth_ready"
  | "provider_created"
  | "provider_enabled"
  | "scheduled_probe";

export type ProviderModelRefreshSource = "api_key_saved" | "manual_refresh" | "oauth_ready";

export type ProviderConnectionProbeJobPayload = {
  providerConnectionId: string;
  providerId: string;
  source: ProviderConnectionProbeSource;
};

export type ProviderConnectionProbeJobResult =
  | { jobId: string; queued: true; reused: boolean }
  | {
      queued: false;
      reason: "connection_disabled" | "connection_missing" | "provider_disabled";
    };

type ProviderRow = {
  enabled: boolean;
  id: string;
  provider_type: "api_key" | "local" | "subscription";
};

const jobCreatedChannel = "job_created";

export function buildProviderConnectionProbeJobPayload(input: {
  providerConnectionId: string;
  providerId: string;
  source: ProviderConnectionProbeSource;
}): ProviderConnectionProbeJobPayload {
  return {
    providerConnectionId: input.providerConnectionId.trim(),
    providerId: input.providerId.trim(),
    source: input.source,
  };
}

export async function enqueueProviderModelRefreshJob(input: {
  databaseUrl?: string;
  providerId: string;
  source?: ProviderModelRefreshSource;
  trigger?: "manual" | "system";
}): Promise<{ id: string; providerId: string; status: "pending" }> {
  const providerId = requireId(input.providerId, "Provider id");
  const source = input.source ?? "manual_refresh";
  const trigger = input.trigger ?? "manual";
  return withPostgresTransaction(input.databaseUrl, async (client) => {
    const provider = await readProviderForUpdate(client, providerId);
    if (!provider.enabled) {
      throw consoleValidationError(
        "Provider must be enabled before refreshing models.",
        "provider_disabled",
        { providerId },
      );
    }
    if (!(await providerCredentialsReady(client, provider))) {
      throw consoleValidationError(
        "Provider credentials are required before refreshing models.",
        "credential_missing",
        { providerId },
      );
    }

    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `model_refresh:${providerId}`,
    ]);
    const existing = await client.query<{ id: string }>(
      `
        select id::text
        from jobs
        where job_type = 'model_refresh'
          and status in ('pending', 'running')
          and payload ->> 'providerId' = $1
        order by created_at
        limit 1
      `,
      [providerId],
    );
    const jobId = existing.rows[0]?.id ?? randomUUID();
    if (!existing.rows[0]) {
      await client.query(
        `
          insert into jobs (id, job_type, status, trigger, payload, max_attempts)
          values ($1, 'model_refresh', 'pending', $2, $3::jsonb, 3)
        `,
        [jobId, trigger, JSON.stringify({ providerId, source })],
      );
    }
    await notifyJobCreated(client, jobId);
    return { id: jobId, providerId, status: "pending" };
  });
}

export async function enqueueProviderConnectionProbeJob(input: {
  databaseUrl?: string;
  providerConnectionId: string;
  providerId: string;
  resetHealth?: boolean;
  source: ProviderConnectionProbeSource;
  trigger?: "manual" | "scheduled" | "system";
}): Promise<ProviderConnectionProbeJobResult> {
  const providerId = requireId(input.providerId, "Provider id");
  const providerConnectionId = requireId(input.providerConnectionId, "Provider connection id");

  return withPostgresTransaction(input.databaseUrl, async (client) => {
    const provider = await readProviderForUpdate(client, providerId);
    if (!provider.enabled) {
      return { queued: false, reason: "provider_disabled" };
    }
    const connectionState = await readConnectionState(client, {
      provider,
      providerConnectionId,
    });
    if (connectionState === "missing") {
      return { queued: false, reason: "connection_missing" };
    }
    if (connectionState === "disabled") {
      return { queued: false, reason: "connection_disabled" };
    }

    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `provider_connection_probe:${providerId}:${providerConnectionId}`,
    ]);
    if (input.resetHealth) {
      await clearProviderConnectionHealthWithClient(client, { providerConnectionId, providerId });
    }

    const existing = await client.query<{ id: string; status: string }>(
      `
        select id::text, status
        from jobs
        where job_type = 'provider_connection_probe'
          and (status = 'pending' or ($3::boolean = false and status = 'running'))
          and payload ->> 'providerId' = $1
          and payload ->> 'providerConnectionId' = $2
        order by case when status = 'pending' then 0 else 1 end, created_at
        limit 1
        for update
      `,
      [providerId, providerConnectionId, input.resetHealth ?? false],
    );
    const active = existing.rows[0];
    if (active) {
      if (
        (input.trigger === "manual" || input.source === "manual_probe") &&
        active.status === "pending"
      ) {
        await client.query(
          `
            update jobs
            set run_after = now(),
                trigger = 'manual',
                payload = jsonb_set(payload, '{source}', '"manual_probe"'::jsonb),
                updated_at = now()
            where id = $1
          `,
          [active.id],
        );
      }
      await notifyJobCreated(client, active.id);
      return { jobId: active.id, queued: true, reused: true };
    }

    const jobId = randomUUID();
    await client.query(
      `
        insert into jobs (id, job_type, status, trigger, payload, max_attempts)
        values ($1, 'provider_connection_probe', 'pending', $2, $3::jsonb, 3)
      `,
      [
        jobId,
        input.trigger ?? (input.source === "manual_probe" ? "manual" : "system"),
        JSON.stringify(
          buildProviderConnectionProbeJobPayload({
            providerConnectionId,
            providerId,
            source: input.source,
          }),
        ),
      ],
    );
    await notifyJobCreated(client, jobId);
    return { jobId, queued: true, reused: false };
  });
}

export async function enqueueProviderConnectionProbesForProvider(input: {
  databaseUrl?: string;
  providerId: string;
  resetHealth?: boolean;
  source: ProviderConnectionProbeSource;
}): Promise<ProviderConnectionProbeJobResult[]> {
  const providerId = requireId(input.providerId, "Provider id");
  const connections = await withPostgresTransaction(input.databaseUrl, async (client) => {
    const provider = await readProviderForUpdate(client, providerId);
    if (!provider.enabled) {
      return [];
    }
    if (provider.provider_type === "local") {
      return [provider.id];
    }
    const table = provider.provider_type === "api_key" ? "provider_api_keys" : "provider_oauth";
    const ready =
      provider.provider_type === "api_key"
        ? "enabled = true and deleted_at is null"
        : "enabled = true and deleted_at is null and completed_at is not null and encrypted_token is not null";
    const result = await client.query<{ id: string }>(
      `select id::text from ${table} where provider_id = $1 and ${ready} order by priority, created_at, id`,
      [providerId],
    );
    return result.rows.map((row) => row.id);
  });

  const results: ProviderConnectionProbeJobResult[] = [];
  for (const providerConnectionId of connections) {
    results.push(
      await enqueueProviderConnectionProbeJob({
        databaseUrl: input.databaseUrl,
        providerConnectionId,
        providerId,
        resetHealth: input.resetHealth,
        source: input.source,
      }),
    );
  }
  return results;
}

async function readProviderForUpdate(
  client: PostgresQueryClient,
  providerId: string,
): Promise<ProviderRow> {
  const result = await client.query<ProviderRow>(
    `
      select id::text, enabled, provider_type
      from providers
      where id = $1
        and deleted_at is null
      for update
    `,
    [providerId],
  );
  const provider = result.rows[0];
  if (!provider) {
    throw consoleNotFoundError("Provider was not found.", "provider_not_found", { providerId });
  }
  return provider;
}

async function readConnectionState(
  client: PostgresQueryClient,
  input: { provider: ProviderRow; providerConnectionId: string },
): Promise<"disabled" | "missing" | "ready"> {
  if (input.provider.provider_type === "local") {
    return input.providerConnectionId === input.provider.id ? "ready" : "missing";
  }
  const table = input.provider.provider_type === "api_key" ? "provider_api_keys" : "provider_oauth";
  const result = await client.query<{
    completed: boolean;
    enabled: boolean;
  }>(
    `
      select enabled,
             ${input.provider.provider_type === "subscription" ? "completed_at is not null and encrypted_token is not null" : "true"} as completed
      from ${table}
      where id = $1
        and provider_id = $2
        and deleted_at is null
    `,
    [input.providerConnectionId, input.provider.id],
  );
  const connection = result.rows[0];
  if (!connection?.completed) {
    return "missing";
  }
  return connection.enabled ? "ready" : "disabled";
}

async function providerCredentialsReady(
  client: PostgresQueryClient,
  provider: ProviderRow,
): Promise<boolean> {
  if (provider.provider_type === "local") {
    return true;
  }
  const table = provider.provider_type === "api_key" ? "provider_api_keys" : "provider_oauth";
  const ready =
    provider.provider_type === "api_key"
      ? "enabled = true and deleted_at is null"
      : "enabled = true and deleted_at is null and completed_at is not null and encrypted_token is not null";
  const result = await client.query<{ ready: boolean }>(
    `select exists(select 1 from ${table} where provider_id = $1 and ${ready}) as ready`,
    [provider.id],
  );
  return result.rows[0]?.ready === true;
}

function requireId(value: string, label: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw consoleValidationError(
      `${label} is required.`,
      `${label.toLowerCase().replaceAll(" ", "_")}_required`,
    );
  }
  return normalized;
}

async function notifyJobCreated(client: PostgresQueryClient, jobId: string): Promise<void> {
  await client.query("select pg_notify($1, $2)", [jobCreatedChannel, JSON.stringify({ jobId })]);
}
