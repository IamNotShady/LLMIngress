import { PostgresClient } from "@llmingress/db/client";
import { type JobHandler, JobHandlerError } from "./worker-job-runner.ts";

export type RetentionCleanupPayload = {
  cutoff: Date;
  retentionDays: number;
};

export type RetentionCleanupSettings = {
  intervalMs: number;
  retentionDays: number;
};

export type RetentionCleanupResult = {
  cutoff: string;
  deletedRequestActivityCount: number;
  preservedBudgetPeriodCount: number;
  preservedRateLimitWindowCount: number;
  retentionDays: number;
};

type CreateRetentionCleanupJobHandlerOptions = {
  databaseUrl?: string;
  now?: () => Date;
};

type CleanupExpiredDataOptions = CreateRetentionCleanupJobHandlerOptions & {
  payload: unknown;
};

type RetentionCleanupRow = {
  deleted_request_activity_count: number;
  preserved_budget_period_count: number;
  preserved_rate_limit_window_count: number;
};

const dayMs = 24 * 60 * 60 * 1000;
const defaultRetentionCleanupDays = 30;
const defaultRetentionCleanupIntervalMs = dayMs;

export function createRetentionCleanupJobHandler(
  options: CreateRetentionCleanupJobHandlerOptions,
): JobHandler {
  return async (job) => cleanupExpiredOperationalData({ ...options, payload: job.payload });
}

export async function cleanupExpiredOperationalData(
  options: CleanupExpiredDataOptions,
): Promise<RetentionCleanupResult> {
  const parsedPayload = readRetentionCleanupPayload(options.payload, options.now?.() ?? new Date());
  const client = new PostgresClient({ connectionString: options.databaseUrl });
  await client.connect();

  try {
    await client.query("begin");
    const result = await client.query<RetentionCleanupRow>(
      `
        with expired_request_activity as (
          select id
          from request_activity
          where created_at < $1::timestamptz
        ),
        deleted_fallback_events as (
          delete from fallback_events
          where request_activity_id in (select id from expired_request_activity)
          returning id
        ),
        deleted_request_costs as (
          delete from request_costs
          where request_activity_id in (select id from expired_request_activity)
          returning id
        ),
        deleted_request_usage as (
          delete from request_usage
          where request_activity_id in (select id from expired_request_activity)
          returning id
        ),
        cleared_runtime_errors as (
          update runtime_errors
          set request_activity_id = null
          where request_activity_id in (select id from expired_request_activity)
          returning id
        ),
        deleted_request_activity as (
          delete from request_activity
          where id in (select id from expired_request_activity)
          returning id
        )
        select
          (select count(*)::integer from deleted_request_activity)
            as deleted_request_activity_count,
          (select count(*)::integer from budget_periods) as preserved_budget_period_count,
          (select count(*)::integer from rate_limit_windows) as preserved_rate_limit_window_count
      `,
      [parsedPayload.cutoff.toISOString()],
    );
    await client.query("commit");

    const row = result.rows[0];
    return {
      cutoff: parsedPayload.cutoff.toISOString(),
      deletedRequestActivityCount: row?.deleted_request_activity_count ?? 0,
      preservedBudgetPeriodCount: row?.preserved_budget_period_count ?? 0,
      preservedRateLimitWindowCount: row?.preserved_rate_limit_window_count ?? 0,
      retentionDays: parsedPayload.retentionDays,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

export function readRetentionCleanupPayload(payload: unknown, now: Date): RetentionCleanupPayload {
  const rawPayload = readObject(payload);
  const retentionDays = rawPayload.retentionDays;

  if (typeof retentionDays !== "number" || !Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new JobHandlerError(
      "retention_cleanup_invalid_payload",
      "Retention cleanup payload retentionDays must be a positive integer.",
    );
  }

  return {
    cutoff: new Date(now.getTime() - retentionDays * dayMs),
    retentionDays,
  };
}

export function readRetentionCleanupSettings(
  env: Partial<Record<string, string | undefined>> = process.env,
): RetentionCleanupSettings {
  return {
    intervalMs: readPositiveIntegerEnv(
      env.RETENTION_CLEANUP_INTERVAL_MS,
      defaultRetentionCleanupIntervalMs,
      "RETENTION_CLEANUP_INTERVAL_MS",
    ),
    retentionDays: readPositiveIntegerEnv(
      env.RETENTION_CLEANUP_DAYS,
      defaultRetentionCleanupDays,
      "RETENTION_CLEANUP_DAYS",
    ),
  };
}

function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
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
