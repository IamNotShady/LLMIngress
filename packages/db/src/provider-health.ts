import { randomUUID } from "node:crypto";
import { type PostgresQueryClient, withPostgresTransaction } from "@llmingress/db/client";
import type { QueryResultRow } from "pg";

export const JOB_CREATED_CHANNEL = "job_created";

export type ProviderHealthEventStatus = "healthy" | "unhealthy";
export type ProviderHealthEventTrigger = "manual" | "worker_probe";

export type ProviderConnectionProbeResultInput = {
  databaseUrl?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  jobId?: string | null;
  latencyMs?: number | null;
  metadata?: Record<string, unknown>;
  observedAt?: Date;
  providerConnectionId: string;
  providerId: string;
  status: ProviderHealthEventStatus;
  trigger: ProviderHealthEventTrigger;
};

export type ProviderConnectionProbePersistenceResult = {
  consecutiveFailures: number;
  duplicate: boolean;
  eventId: string;
  nextJobId: string | null;
  nextProbeAt: Date | null;
};

type ProviderHealthSummaryRow = QueryResultRow & {
  consecutive_failures: number;
  id: string;
};

export async function recordProviderConnectionProbeResult(
  input: ProviderConnectionProbeResultInput,
): Promise<ProviderConnectionProbePersistenceResult> {
  return withPostgresTransaction(input.databaseUrl, (client) =>
    recordProviderConnectionProbeResultWithClient(client, input),
  );
}

export async function recordProviderConnectionProbeResultWithClient(
  client: PostgresQueryClient,
  input: Omit<ProviderConnectionProbeResultInput, "databaseUrl">,
): Promise<ProviderConnectionProbePersistenceResult> {
  const observedAt = input.observedAt ?? new Date();
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `provider_connection_health:${input.providerId}:${input.providerConnectionId}`,
  ]);

  if (input.jobId) {
    const existing = await client.query<{
      consecutive_failures: number | null;
      event_id: string;
      next_job_id: string | null;
      next_probe_at: Date | null;
    }>(
      `
        select events.id::text as event_id,
               summary.consecutive_failures,
               summary.next_probe_at,
               (
                 select jobs.id::text
                 from jobs
                 where jobs.job_type = 'provider_connection_probe'
                   and jobs.status = 'pending'
                   and jobs.payload ->> 'sourceJobId' = $1::text
                 order by jobs.created_at
                 limit 1
               ) as next_job_id
        from provider_health_events as events
        left join provider_health_summary as summary
          on summary.last_event_id = events.id
        where events.job_id = $1::uuid
      `,
      [input.jobId],
    );
    const prior = existing.rows[0];
    if (prior) {
      return {
        consecutiveFailures: prior.consecutive_failures ?? 0,
        duplicate: true,
        eventId: prior.event_id,
        nextJobId: prior.next_job_id,
        nextProbeAt: prior.next_probe_at,
      };
    }
  }

  const eventId = randomUUID();
  await client.query(
    `
      insert into provider_health_events (
        id,
        provider_id,
        provider_connection_id,
        job_id,
        trigger,
        status,
        error_code,
        error_message,
        latency_ms,
        observed_at,
        metadata
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
    `,
    [
      eventId,
      input.providerId,
      input.providerConnectionId,
      input.jobId ?? null,
      input.trigger,
      input.status,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      input.latencyMs ?? null,
      observedAt,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  if (input.status === "healthy") {
    await client.query(
      `
        delete from provider_health_summary
        where provider_id = $1
          and provider_connection_id = $2
      `,
      [input.providerId, input.providerConnectionId],
    );
    await cancelPendingConnectionProbeJobs(client, {
      exceptJobId: input.jobId ?? null,
      providerConnectionId: input.providerConnectionId,
      providerId: input.providerId,
    });
    return {
      consecutiveFailures: 0,
      duplicate: false,
      eventId,
      nextJobId: null,
      nextProbeAt: null,
    };
  }

  const previous = await client.query<ProviderHealthSummaryRow>(
    `
      select id::text, consecutive_failures
      from provider_health_summary
      where provider_id = $1
        and provider_connection_id = $2
      for update
    `,
    [input.providerId, input.providerConnectionId],
  );
  const consecutiveFailures = (previous.rows[0]?.consecutive_failures ?? 0) + 1;
  const nextProbeAt = new Date(
    observedAt.getTime() + providerConnectionProbeRetryDelayMs(consecutiveFailures),
  );
  const summaryId = previous.rows[0]?.id ?? randomUUID();
  await client.query(
    `
      insert into provider_health_summary (
        id,
        provider_id,
        provider_connection_id,
        last_event_id,
        status,
        consecutive_failures,
        last_failure_at,
        reason_code,
        reason_message,
        next_probe_at,
        updated_at
      )
      values ($1, $2, $3, $4, 'unhealthy', $5, $6, $7, $8, $9, $6)
      on conflict (provider_id, provider_connection_id)
      do update set
        last_event_id = excluded.last_event_id,
        consecutive_failures = excluded.consecutive_failures,
        last_failure_at = excluded.last_failure_at,
        reason_code = excluded.reason_code,
        reason_message = excluded.reason_message,
        next_probe_at = excluded.next_probe_at,
        updated_at = excluded.updated_at
    `,
    [
      summaryId,
      input.providerId,
      input.providerConnectionId,
      eventId,
      consecutiveFailures,
      observedAt,
      input.errorCode ?? "provider_connection_probe_failed",
      input.errorMessage ?? "Provider connection probe failed.",
      nextProbeAt,
    ],
  );
  const nextJobId = await enqueueScheduledConnectionProbe(client, {
    providerConnectionId: input.providerConnectionId,
    providerId: input.providerId,
    runAfter: nextProbeAt,
    sourceJobId: input.jobId ?? eventId,
  });
  return {
    consecutiveFailures,
    duplicate: false,
    eventId,
    nextJobId,
    nextProbeAt,
  };
}

export async function clearProviderConnectionHealthWithClient(
  client: PostgresQueryClient,
  input: { providerConnectionId: string; providerId: string },
): Promise<void> {
  await client.query(
    `
      delete from provider_health_summary
      where provider_id = $1
        and provider_connection_id = $2
    `,
    [input.providerId, input.providerConnectionId],
  );
  await cancelPendingConnectionProbeJobs(client, {
    exceptJobId: null,
    providerConnectionId: input.providerConnectionId,
    providerId: input.providerId,
  });
}

export function providerConnectionProbeRetryDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 1) {
    return 5 * 60_000;
  }
  if (consecutiveFailures === 2) {
    return 10 * 60_000;
  }
  if (consecutiveFailures === 3) {
    return 30 * 60_000;
  }
  return 60 * 60_000;
}

async function enqueueScheduledConnectionProbe(
  client: PostgresQueryClient,
  input: {
    providerConnectionId: string;
    providerId: string;
    runAfter: Date;
    sourceJobId: string;
  },
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `
      select id::text
      from jobs
      where job_type = 'provider_connection_probe'
        and status = 'pending'
        and payload ->> 'providerId' = $1
        and payload ->> 'providerConnectionId' = $2
      order by run_after, created_at
      limit 1
      for update
    `,
    [input.providerId, input.providerConnectionId],
  );
  const existingJobId = existing.rows[0]?.id;
  if (existingJobId) {
    await client.query(
      "update jobs set run_after = least(run_after, $2), updated_at = now() where id = $1",
      [existingJobId, input.runAfter],
    );
    return existingJobId;
  }

  const jobId = randomUUID();
  await client.query(
    `
      insert into jobs (id, job_type, status, trigger, payload, run_after, max_attempts)
      values ($1, 'provider_connection_probe', 'pending', 'scheduled', $2::jsonb, $3, 3)
    `,
    [
      jobId,
      JSON.stringify({
        providerConnectionId: input.providerConnectionId,
        providerId: input.providerId,
        source: "scheduled_probe",
        sourceJobId: input.sourceJobId,
      }),
      input.runAfter,
    ],
  );
  await client.query("select pg_notify($1, $2)", [JOB_CREATED_CHANNEL, JSON.stringify({ jobId })]);
  return jobId;
}

async function cancelPendingConnectionProbeJobs(
  client: PostgresQueryClient,
  input: {
    exceptJobId: string | null;
    providerConnectionId: string;
    providerId: string;
  },
): Promise<void> {
  await client.query(
    `
      update jobs
      set status = 'canceled',
          lease_owner = null,
          lease_expires_at = null,
          completed_at = now(),
          updated_at = now()
      where job_type = 'provider_connection_probe'
        and status = 'pending'
        and payload ->> 'providerId' = $1
        and payload ->> 'providerConnectionId' = $2
        and ($3::uuid is null or id <> $3::uuid)
    `,
    [input.providerId, input.providerConnectionId, input.exceptJobId],
  );
}
