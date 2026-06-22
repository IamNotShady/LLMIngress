import { unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { PostgresClient, type PostgresQueryResultRow } from "@llmingress/db/maintenance";
import { type JobHandler, JobHandlerError } from "./job-runner.js";

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
  deletedExportFileCount: number;
  deletedExportTaskCount: number;
  deletedRequestActivityCount: number;
  preservedBudgetPeriodCount: number;
  preservedRateLimitWindowCount: number;
  retentionDays: number;
};

type CreateRetentionCleanupJobHandlerOptions = {
  databaseUrl: string;
  now?: () => Date;
};

type CleanupExpiredDataOptions = CreateRetentionCleanupJobHandlerOptions & {
  payload: unknown;
};

type RetentionCleanupRow = PostgresQueryResultRow & {
  deleted_export_task_count: number;
  deleted_request_activity_count: number;
  preserved_budget_period_count: number;
  preserved_rate_limit_window_count: number;
};

type ExpiredExportTaskRow = PostgresQueryResultRow & {
  id: string;
  output_path: string;
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
    const expiredExportTasks = await client.query<ExpiredExportTaskRow>(
      `
        select id::text,
               result->>'outputPath' as output_path
        from jobs
        where job_type in ('jsonl_export', 'cost_report_export')
          and status = 'succeeded'
          and completed_at < $1::timestamptz
          and result ? 'outputPath'
          and not result ? 'exportFileDeletedAt'
        for update
      `,
      [parsedPayload.cutoff.toISOString()],
    );
    const deletedExportFileCount = await deleteLocalExportFiles(
      expiredExportTasks.rows.map((row) => row.output_path),
    );
    const result = await client.query<RetentionCleanupRow>(
      `
        with marked_export_jobs as (
          update jobs
          set result = jsonb_set(
                result,
                '{exportFileDeletedAt}',
                to_jsonb($3::text),
                true
              ),
              updated_at = now()
          where id = any($2::uuid[])
          returning id
        ),
        deleted_request_activity as (
          delete from request_activity
          where created_at < $1::timestamptz
          returning id
        )
        select
          (select count(*)::integer from marked_export_jobs) as deleted_export_task_count,
          (select count(*)::integer from deleted_request_activity)
            as deleted_request_activity_count,
          (select count(*)::integer from budget_periods) as preserved_budget_period_count,
          (select count(*)::integer from rate_limit_windows) as preserved_rate_limit_window_count
      `,
      [
        parsedPayload.cutoff.toISOString(),
        expiredExportTasks.rows.map((row) => row.id),
        (options.now?.() ?? new Date()).toISOString(),
      ],
    );
    await client.query("commit");

    const row = result.rows[0];
    return {
      cutoff: parsedPayload.cutoff.toISOString(),
      deletedExportFileCount,
      deletedExportTaskCount: row?.deleted_export_task_count ?? 0,
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

async function deleteLocalExportFiles(outputPaths: string[]): Promise<number> {
  let deletedCount = 0;

  for (const outputPath of outputPaths) {
    if (!isAbsolute(outputPath)) {
      continue;
    }

    try {
      await unlink(outputPath);
      deletedCount += 1;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  return deletedCount;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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
