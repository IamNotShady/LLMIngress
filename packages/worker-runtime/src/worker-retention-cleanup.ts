import { PostgresClient } from "@llmingress/db/client";

export type RetentionCleanupSettings = {
  activityDays: number;
  healthEventDays: number;
  intervalMs: number;
  jobDays: number;
};

export type RetentionCleanupResult = {
  deletedHealthEventCount: number;
  deletedJobAttemptCount: number;
  deletedJobCount: number;
  deletedRequestActivityCount: number;
};

type CleanupExpiredDataOptions = {
  databaseUrl?: string;
  now?: () => Date;
  settings?: RetentionCleanupSettings;
  signal?: AbortSignal;
};

type ActivityCleanupRow = {
  deleted_request_activity_count: number;
};

type JobCleanupRow = {
  deleted_job_attempt_count: number;
  deleted_job_count: number;
};

type HealthCleanupRow = {
  deleted_health_event_count: number;
};

const dayMs = 24 * 60 * 60 * 1000;
const defaultRetentionCleanupIntervalMs = dayMs;

export async function cleanupExpiredOperationalData(
  options: CleanupExpiredDataOptions = {},
): Promise<RetentionCleanupResult> {
  const now = options.now?.() ?? new Date();
  const settings = options.settings ?? readRetentionCleanupSettings();
  const signal = options.signal ?? new AbortController().signal;
  const client = new PostgresClient({ connectionString: options.databaseUrl });
  await client.connect();

  try {
    const deletedRequestActivityCount = await deleteActivityBatches(
      client,
      new Date(now.getTime() - settings.activityDays * dayMs),
      signal,
    );
    const jobs = await deleteJobBatches(
      client,
      new Date(now.getTime() - settings.jobDays * dayMs),
      signal,
    );
    const deletedHealthEventCount = await deleteHealthEventBatches(
      client,
      new Date(now.getTime() - settings.healthEventDays * dayMs),
      signal,
    );
    return {
      deletedHealthEventCount,
      deletedJobAttemptCount: jobs.deletedJobAttemptCount,
      deletedJobCount: jobs.deletedJobCount,
      deletedRequestActivityCount,
    };
  } finally {
    await client.end();
  }
}

export function readRetentionCleanupSettings(
  env: Partial<Record<string, string | undefined>> = process.env,
): RetentionCleanupSettings {
  return {
    activityDays: readPositiveIntegerEnv(
      env.WORKER_ACTIVITY_RETENTION_DAYS ?? env.RETENTION_CLEANUP_DAYS,
      30,
      "WORKER_ACTIVITY_RETENTION_DAYS",
    ),
    healthEventDays: readPositiveIntegerEnv(
      env.WORKER_HEALTH_EVENT_RETENTION_DAYS,
      30,
      "WORKER_HEALTH_EVENT_RETENTION_DAYS",
    ),
    intervalMs: readPositiveIntegerEnv(
      env.RETENTION_CLEANUP_INTERVAL_MS,
      defaultRetentionCleanupIntervalMs,
      "RETENTION_CLEANUP_INTERVAL_MS",
    ),
    jobDays: readPositiveIntegerEnv(env.WORKER_JOB_RETENTION_DAYS, 7, "WORKER_JOB_RETENTION_DAYS"),
  };
}

async function deleteActivityBatches(
  client: PostgresClient,
  cutoff: Date,
  signal: AbortSignal,
): Promise<number> {
  let deleted = 0;
  while (!signal.aborted) {
    await client.query("begin");
    try {
      const result = await client.query<ActivityCleanupRow>(
        `
          with expired as (
            select id
            from request_activity
            where created_at < $1::timestamptz
            order by created_at, id
            limit 1000
          ),
          deleted_fallback as (
            delete from fallback_events where request_activity_id in (select id from expired)
          ),
          deleted_costs as (
            delete from request_costs where request_activity_id in (select id from expired)
          ),
          deleted_usage as (
            delete from request_usage where request_activity_id in (select id from expired)
          ),
          deleted_activity as (
            delete from request_activity where id in (select id from expired) returning id
          )
          select count(*)::int as deleted_request_activity_count from deleted_activity
        `,
        [cutoff.toISOString()],
      );
      await client.query("commit");
      const batchCount = result.rows[0]?.deleted_request_activity_count ?? 0;
      deleted += batchCount;
      if (batchCount < 1000) {
        return deleted;
      }
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  }
  return deleted;
}

async function deleteJobBatches(
  client: PostgresClient,
  cutoff: Date,
  signal: AbortSignal,
): Promise<{ deletedJobAttemptCount: number; deletedJobCount: number }> {
  let deletedJobAttemptCount = 0;
  let deletedJobCount = 0;
  while (!signal.aborted) {
    await client.query("begin");
    try {
      const result = await client.query<JobCleanupRow>(
        `
          with expired as (
            select id
            from jobs
            where status in ('succeeded', 'failed', 'canceled')
              and completed_at < $1::timestamptz
            order by completed_at, id
            limit 1000
          ),
          deleted_attempts as (
            delete from job_attempts where job_id in (select id from expired) returning id
          ),
          deleted_jobs as (
            delete from jobs where id in (select id from expired) returning id
          )
          select
            (select count(*)::int from deleted_attempts) as deleted_job_attempt_count,
            (select count(*)::int from deleted_jobs) as deleted_job_count
        `,
        [cutoff.toISOString()],
      );
      await client.query("commit");
      const batchJobCount = result.rows[0]?.deleted_job_count ?? 0;
      deletedJobAttemptCount += result.rows[0]?.deleted_job_attempt_count ?? 0;
      deletedJobCount += batchJobCount;
      if (batchJobCount < 1000) {
        return { deletedJobAttemptCount, deletedJobCount };
      }
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  }
  return { deletedJobAttemptCount, deletedJobCount };
}

async function deleteHealthEventBatches(
  client: PostgresClient,
  cutoff: Date,
  signal: AbortSignal,
): Promise<number> {
  let deleted = 0;
  while (!signal.aborted) {
    const result = await client.query<HealthCleanupRow>(
      `
        with expired as (
          select event.id
          from provider_health_events as event
          where event.observed_at < $1::timestamptz
            and not exists (
              select 1 from provider_health_summary as summary
              where summary.last_event_id = event.id
            )
          order by event.observed_at, event.id
          limit 1000
        ),
        deleted_events as (
          delete from provider_health_events where id in (select id from expired) returning id
        )
        select count(*)::int as deleted_health_event_count from deleted_events
      `,
      [cutoff.toISOString()],
    );
    const batchCount = result.rows[0]?.deleted_health_event_count ?? 0;
    deleted += batchCount;
    if (batchCount < 1000) {
      return deleted;
    }
  }
  return deleted;
}

function readPositiveIntegerEnv(
  value: string | undefined,
  defaultValue: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}
