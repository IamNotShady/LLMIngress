import { randomUUID } from "node:crypto";
import { Client, type QueryResultRow } from "pg";

export const HEALTH_SUMMARY_CHANGED_CHANNEL = "health_summary_changed";

export type ProviderHealthFailureStatus =
  | "auth_failed"
  | "network_error"
  | "quota_limited"
  | "unhealthy";
export type ProviderHealthEventStatus = "healthy" | ProviderHealthFailureStatus;
export type ProviderHealthEventTrigger = "manual" | "request_path" | "worker_probe";
export type ProviderHealthSummaryStatus = "healthy" | "unknown" | ProviderHealthFailureStatus;

export type ProviderHealthSummaryState = {
  consecutiveFailures: number;
  lastFailureAt: Date | null;
  lastSuccessAt: Date | null;
  status: ProviderHealthSummaryStatus;
};

export type HealthSummaryChangedPayload = {
  consecutiveFailures: number;
  eventId: string;
  providerId: string;
  providerModelId: string | null;
  status: ProviderHealthSummaryStatus;
  summaryId: string;
};

export type RecordProviderHealthEventInput = {
  databaseUrl: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  jobId?: string | null;
  latencyMs?: number | null;
  metadata?: Record<string, unknown>;
  observedAt?: Date;
  providerId: string;
  providerModelId?: string | null;
  status: ProviderHealthEventStatus;
  trigger: ProviderHealthEventTrigger;
};

export type RecordProviderHealthEventResult = {
  eventId: string;
  notification: HealthSummaryChangedPayload;
  summaryId: string;
};

type ProviderHealthSummaryRow = QueryResultRow & {
  consecutive_failures: number;
  id: string;
  last_failure_at: Date | null;
  last_success_at: Date | null;
  status: ProviderHealthSummaryStatus;
};

export function buildProviderHealthSummaryUpdate(input: {
  eventStatus: ProviderHealthEventStatus;
  observedAt: Date;
  previous: ProviderHealthSummaryState | null;
}): ProviderHealthSummaryState {
  if (input.eventStatus === "healthy") {
    return {
      consecutiveFailures: 0,
      lastFailureAt: input.previous?.lastFailureAt ?? null,
      lastSuccessAt: input.observedAt,
      status: "healthy",
    };
  }

  return {
    consecutiveFailures: (input.previous?.consecutiveFailures ?? 0) + 1,
    lastFailureAt: input.observedAt,
    lastSuccessAt: input.previous?.lastSuccessAt ?? null,
    status: input.eventStatus,
  };
}

export function buildHealthSummaryChangedPayload(
  input: HealthSummaryChangedPayload,
): HealthSummaryChangedPayload {
  return {
    consecutiveFailures: input.consecutiveFailures,
    eventId: input.eventId,
    providerId: input.providerId,
    providerModelId: input.providerModelId,
    status: input.status,
    summaryId: input.summaryId,
  };
}

export async function createHealthSummaryChangedListener(options: {
  databaseUrl: string;
  onNotification: (payload: HealthSummaryChangedPayload) => void;
}): Promise<{ close: () => Promise<void> }> {
  const client = new Client({ connectionString: options.databaseUrl });
  client.on("notification", (message) => {
    if (message.channel !== HEALTH_SUMMARY_CHANGED_CHANNEL || !message.payload) {
      return;
    }

    try {
      const payload = JSON.parse(message.payload) as HealthSummaryChangedPayload;
      options.onNotification(payload);
    } catch {
      return;
    }
  });

  await client.connect();
  await client.query(`listen ${HEALTH_SUMMARY_CHANGED_CHANNEL}`);

  return {
    close: async () => {
      await client.query(`unlisten ${HEALTH_SUMMARY_CHANGED_CHANNEL}`);
      await client.end();
    },
  };
}

export async function recordProviderHealthEvent(
  input: RecordProviderHealthEventInput,
): Promise<RecordProviderHealthEventResult> {
  const observedAt = input.observedAt ?? new Date();
  const providerModelId = input.providerModelId ?? null;
  const eventId = randomUUID();
  const client = new Client({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `${input.providerId}:${providerModelId ?? "provider"}`,
    ]);

    const previous = await readProviderHealthSummaryForUpdate(client, {
      providerId: input.providerId,
      providerModelId,
    });
    await insertProviderHealthEvent(client, {
      ...input,
      eventId,
      observedAt,
      providerModelId,
    });

    const next = buildProviderHealthSummaryUpdate({
      eventStatus: input.status,
      observedAt,
      previous: previous
        ? {
            consecutiveFailures: previous.consecutive_failures,
            lastFailureAt: previous.last_failure_at,
            lastSuccessAt: previous.last_success_at,
            status: previous.status,
          }
        : null,
    });
    const summaryId = previous?.id ?? randomUUID();
    await upsertProviderHealthSummary(client, {
      eventId,
      providerId: input.providerId,
      providerModelId,
      summary: next,
      summaryId,
      updatedAt: observedAt,
    });

    const notification = buildHealthSummaryChangedPayload({
      consecutiveFailures: next.consecutiveFailures,
      eventId,
      providerId: input.providerId,
      providerModelId,
      status: next.status,
      summaryId,
    });
    await client.query("select pg_notify($1, $2)", [
      HEALTH_SUMMARY_CHANGED_CHANNEL,
      JSON.stringify(notification),
    ]);
    await client.query("commit");

    return {
      eventId,
      notification,
      summaryId,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function readProviderHealthSummaryForUpdate(
  client: Client,
  input: { providerId: string; providerModelId: string | null },
): Promise<ProviderHealthSummaryRow | null> {
  const result = await client.query<ProviderHealthSummaryRow>(
    `
      select id::text,
             status,
             consecutive_failures,
             last_success_at,
             last_failure_at
      from provider_health_summary
      where provider_id = $1
        and (
          ($2::uuid is null and provider_model_id is null)
          or provider_model_id = $2::uuid
        )
      for update
    `,
    [input.providerId, input.providerModelId],
  );
  return result.rows[0] ?? null;
}

async function insertProviderHealthEvent(
  client: Client,
  input: Omit<RecordProviderHealthEventInput, "databaseUrl"> & {
    eventId: string;
    observedAt: Date;
    providerModelId: string | null;
  },
): Promise<void> {
  await client.query(
    `
      insert into provider_health_events (
        id,
        provider_id,
        provider_model_id,
        job_id,
        trigger,
        status,
        error_code,
        error_message,
        latency_ms,
        observed_at,
        metadata
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::jsonb)
    `,
    [
      input.eventId,
      input.providerId,
      input.providerModelId,
      input.jobId ?? null,
      input.trigger,
      input.status,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      input.latencyMs ?? null,
      input.observedAt.toISOString(),
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

async function upsertProviderHealthSummary(
  client: Client,
  input: {
    eventId: string;
    providerId: string;
    providerModelId: string | null;
    summary: ProviderHealthSummaryState;
    summaryId: string;
    updatedAt: Date;
  },
): Promise<void> {
  await client.query(
    `
      insert into provider_health_summary (
        id,
        provider_id,
        provider_model_id,
        last_event_id,
        status,
        consecutive_failures,
        last_success_at,
        last_failure_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz)
      on conflict (id)
      do update set
        last_event_id = excluded.last_event_id,
        status = excluded.status,
        consecutive_failures = excluded.consecutive_failures,
        last_success_at = excluded.last_success_at,
        last_failure_at = excluded.last_failure_at,
        updated_at = excluded.updated_at
    `,
    [
      input.summaryId,
      input.providerId,
      input.providerModelId,
      input.eventId,
      input.summary.status,
      input.summary.consecutiveFailures,
      input.summary.lastSuccessAt?.toISOString() ?? null,
      input.summary.lastFailureAt?.toISOString() ?? null,
      input.updatedAt.toISOString(),
    ],
  );
}
