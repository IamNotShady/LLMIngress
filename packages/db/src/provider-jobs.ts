import { randomUUID } from "node:crypto";
import { type PostgresQueryClient, withPostgresTransaction } from "@llmingress/db/client";
import { consoleNotFoundError, consoleValidationError } from "./console-operation-error.ts";

export type ProviderModelRefreshInput = {
  providerId?: string | null;
};

export type NormalizedProviderModelRefreshInput = {
  providerId: string;
};

export type QueuedProviderModelRefreshJob = {
  id: string;
  providerId: string;
  status: "pending";
};

export type ProviderProbeSource =
  | "api_key_saved"
  | "base_url_changed"
  | "manual_probe"
  | "oauth_ready"
  | "provider_created"
  | "provider_enabled"
  | "scheduled_probe";

export type ProviderProbeJobPayload = {
  followUpProbe: true;
  providerId: string;
  source: ProviderProbeSource;
};

export type ProviderProbeLifecycleResult =
  | { jobId: string; queued: true }
  | { queued: false; reason: "credential_missing" | "provider_disabled" };

type ProviderRow = {
  enabled: boolean;
  id: string;
  provider_type: "api_key" | "local" | "subscription";
};

const jobCreatedChannel = "job_created";

export function normalizeProviderModelRefreshInput(
  input: ProviderModelRefreshInput,
): NormalizedProviderModelRefreshInput {
  const providerId = input.providerId?.trim();
  if (!providerId) {
    throw consoleValidationError("Provider id is required.", "provider_id_required", {
      field: "providerId",
    });
  }
  return { providerId };
}

export function buildProviderProbeJobPayload(
  providerId: string,
  source: ProviderProbeSource,
): ProviderProbeJobPayload {
  return { followUpProbe: true, providerId, source };
}

export function buildJobCreatedNotificationPayload(jobId: string): { jobId: string } {
  return { jobId };
}

export async function enqueueProviderModelRefreshJob(input: {
  databaseUrl?: string;
  providerId: string;
}): Promise<QueuedProviderModelRefreshJob> {
  const { providerId } = normalizeProviderModelRefreshInput(input);
  const result = await enqueueProviderProbeLifecycleJob({
    databaseUrl: input.databaseUrl,
    providerId,
    source: "manual_probe",
    trigger: "manual",
  });
  if (!result.queued) {
    throw consoleValidationError(
      result.reason === "provider_disabled"
        ? "Provider must be enabled before refreshing models."
        : "Provider credentials are required before refreshing models.",
      result.reason,
      { providerId },
    );
  }

  return {
    id: result.jobId,
    providerId,
    status: "pending",
  };
}

export async function enqueueProviderProbeLifecycleJob(input: {
  databaseUrl?: string;
  providerId: string;
  source: ProviderProbeSource;
  trigger?: "manual" | "system";
}): Promise<ProviderProbeLifecycleResult> {
  const providerId = normalizeProviderModelRefreshInput(input).providerId;
  return withPostgresTransaction(input.databaseUrl, async (client) => {
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
    if (!provider.enabled) {
      return { queued: false, reason: "provider_disabled" };
    }
    if (!(await providerCredentialsReady(client, provider))) {
      return { queued: false, reason: "credential_missing" };
    }

    const jobId = randomUUID();
    await client.query(
      `
        insert into jobs (id, job_type, status, trigger, payload, max_attempts)
        values ($1, 'model_refresh', 'pending', $2, $3::jsonb, 3)
      `,
      [
        jobId,
        input.trigger ?? (input.source === "manual_probe" ? "manual" : "system"),
        JSON.stringify(buildProviderProbeJobPayload(providerId, input.source)),
      ],
    );
    await client.query("select pg_notify($1, $2)", [
      jobCreatedChannel,
      JSON.stringify(buildJobCreatedNotificationPayload(jobId)),
    ]);
    return { jobId, queued: true };
  });
}

async function providerCredentialsReady(
  client: { query: PostgresQueryClient["query"] },
  provider: ProviderRow,
): Promise<boolean> {
  if (provider.provider_type === "local") {
    return true;
  }
  if (provider.provider_type === "api_key") {
    const result = await client.query<{ ready: boolean }>(
      "select exists(select 1 from provider_api_keys where provider_id = $1 and enabled = true) as ready",
      [provider.id],
    );
    return result.rows[0]?.ready === true;
  }
  const result = await client.query<{ ready: boolean }>(
    `
      select exists(
        select 1
        from provider_oauth
        where provider_id = $1
          and enabled = true
          and completed_at is not null
          and encrypted_token is not null
      ) as ready
    `,
    [provider.id],
  );
  return result.rows[0]?.ready === true;
}
