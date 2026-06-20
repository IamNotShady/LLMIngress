import { randomUUID } from "node:crypto";
import { Client } from "pg";

const jobCreatedChannel = "job_created";

export async function enqueueProviderConnectivityCheckJob(input: {
  databaseUrl: string;
  providerApiKeyId?: string;
  providerId: string;
}): Promise<void> {
  const jobId = randomUUID();
  const payload = {
    ...(input.providerApiKeyId ? { providerApiKeyId: input.providerApiKeyId } : {}),
    providerId: input.providerId,
  };
  const client = new Client({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    await client.query(
      `
        insert into jobs (id, job_type, status, trigger, payload, max_attempts)
        values ($1, 'provider_connectivity_check', 'pending', 'system', $2::jsonb, 1)
      `,
      [jobId, JSON.stringify(payload)],
    );
    await client.query("select pg_notify($1, $2)", [jobCreatedChannel, JSON.stringify({ jobId })]);
  } finally {
    await client.end();
  }
}
