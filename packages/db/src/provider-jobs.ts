import { randomUUID } from "node:crypto";
import { withPooledPostgresClient } from "@llmingress/db/client";

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

type ProviderRow = {
  enabled: boolean;
  id: string;
};

const jobCreatedChannel = "job_created";

export function normalizeProviderModelRefreshInput(
  input: ProviderModelRefreshInput,
): NormalizedProviderModelRefreshInput {
  const providerId = input.providerId?.trim();
  if (!providerId) {
    throw new Error("Provider id is required.");
  }
  return { providerId };
}

export function buildModelRefreshJobPayload(providerId: string): { providerId: string } {
  return { providerId };
}

export function buildJobCreatedNotificationPayload(jobId: string): { jobId: string } {
  return { jobId };
}

export async function enqueueProviderModelRefreshJob(input: {
  databaseUrl?: string;
  providerId: string;
}): Promise<QueuedProviderModelRefreshJob> {
  const { providerId } = normalizeProviderModelRefreshInput(input);
  const jobId = randomUUID();
  const jobPayload = buildModelRefreshJobPayload(providerId);
  const notificationPayload = buildJobCreatedNotificationPayload(jobId);

  await withPooledPostgresClient(input.databaseUrl, async (client) => {
    await client.query("begin");

    try {
      const provider = await client.query<ProviderRow>(
        "select id::text, enabled from providers where id = $1 and deleted_at is null for update",
        [providerId],
      );
      const row = provider.rows[0];
      if (!row) {
        throw new Error("Provider was not found.");
      }
      if (!row.enabled) {
        throw new Error("Provider must be enabled before refreshing models.");
      }

      await client.query(
        `
          insert into jobs (id, job_type, status, trigger, payload, max_attempts)
          values ($1, 'model_refresh', 'pending', 'manual', $2::jsonb, 3)
        `,
        [jobId, JSON.stringify(jobPayload)],
      );
      await client.query("select pg_notify($1, $2)", [
        jobCreatedChannel,
        JSON.stringify(notificationPayload),
      ]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });

  return {
    id: jobId,
    providerId,
    status: "pending",
  };
}

export async function enqueueProviderConnectivityCheckJob(input: {
  databaseUrl?: string;
  providerApiKeyId?: string;
  providerId: string;
}): Promise<void> {
  const jobId = randomUUID();
  const payload = {
    ...(input.providerApiKeyId ? { providerApiKeyId: input.providerApiKeyId } : {}),
    providerId: input.providerId,
  };

  await withPooledPostgresClient(input.databaseUrl, async (client) => {
    await client.query(
      `
        insert into jobs (id, job_type, status, trigger, payload, max_attempts)
        values ($1, 'provider_connectivity_check', 'pending', 'system', $2::jsonb, 1)
      `,
      [jobId, JSON.stringify(payload)],
    );
    await client.query("select pg_notify($1, $2)", [jobCreatedChannel, JSON.stringify({ jobId })]);
  });
}
