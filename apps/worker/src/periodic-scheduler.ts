import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { readBackupSettings } from "./backup.js";
import { readBudgetThresholdAlertSettings } from "./budget-threshold-alerts.js";
import { JOB_CREATED_CHANNEL } from "./job-runner.js";
import { readRateLimitAlertSettings } from "./rate-limit-alerts.js";
import { readRetentionCleanupSettings } from "./retention-cleanup.js";

export type PeriodicTaskJobType =
  | "model_refresh"
  | "provider_connectivity_check"
  | "price_sync"
  | "billing_reconciliation"
  | "retention_cleanup"
  | "stale_reservation_cleanup"
  | "webhook_export"
  | "backup"
  | "budget_threshold_alerts"
  | "rate_limit_alerts";

export type PeriodicTaskDefinition = {
  id: string;
  intervalMs: number;
  jobType: PeriodicTaskJobType;
  maxAttempts?: number;
  payload?: Record<string, unknown>;
  priority?: number;
  startAt: Date;
};

export type EnqueueScheduledJobInput = {
  jobType: PeriodicTaskJobType;
  maxAttempts: number;
  payload: Record<string, unknown>;
  priority: number;
  runAfter: Date;
  scheduleWindowStart: Date;
  taskId: string;
};

export type EnqueueScheduledJobResult = {
  created: boolean;
  jobId: string;
};

export type PeriodicSchedulerStore = {
  close?: () => Promise<void>;
  enqueueScheduledJob: (input: EnqueueScheduledJobInput) => Promise<EnqueueScheduledJobResult>;
};

export type PeriodicSchedulerRunResult = {
  createdJobs: number;
  deduplicatedJobs: number;
  skippedTasks: number;
};

export type PeriodicScheduler = {
  runOnce: () => Promise<PeriodicSchedulerRunResult>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

type CreatePeriodicSchedulerOptions = {
  now?: () => Date;
  store: PeriodicSchedulerStore;
  tasks: PeriodicTaskDefinition[];
  tickIntervalMs?: number;
};

type CreatePostgresPeriodicSchedulerOptions = Omit<CreatePeriodicSchedulerOptions, "store"> & {
  databaseUrl: string;
};

const defaultTickIntervalMs = 30_000;

export function createDefaultPeriodicTasks(): PeriodicTaskDefinition[] {
  const backupSettings = readBackupSettings();
  const budgetThresholdAlertSettings = readBudgetThresholdAlertSettings();
  const rateLimitAlertSettings = readRateLimitAlertSettings();
  const retentionCleanupSettings = readRetentionCleanupSettings();

  return [
    {
      id: "stale-reservation-cleanup",
      intervalMs: 60_000,
      jobType: "stale_reservation_cleanup",
      maxAttempts: 1,
      payload: {},
      priority: 0,
      startAt: new Date(0),
    },
    {
      id: "retention-cleanup",
      intervalMs: retentionCleanupSettings.intervalMs,
      jobType: "retention_cleanup",
      maxAttempts: 1,
      payload: { retentionDays: retentionCleanupSettings.retentionDays },
      priority: 0,
      startAt: new Date(0),
    },
    {
      id: "backup",
      intervalMs: backupSettings.intervalMs,
      jobType: "backup",
      maxAttempts: 1,
      payload: { outputDir: backupSettings.outputDir },
      priority: -10,
      startAt: new Date(0),
    },
    {
      id: "budget-threshold-alerts",
      intervalMs: budgetThresholdAlertSettings.intervalMs,
      jobType: "budget_threshold_alerts",
      maxAttempts: 1,
      payload: { thresholdRatios: budgetThresholdAlertSettings.thresholdRatios },
      priority: -5,
      startAt: new Date(0),
    },
    {
      id: "rate-limit-alerts",
      intervalMs: rateLimitAlertSettings.intervalMs,
      jobType: "rate_limit_alerts",
      maxAttempts: 1,
      payload: {
        thresholdCount: rateLimitAlertSettings.thresholdCount,
        windowMs: rateLimitAlertSettings.windowMs,
      },
      priority: -5,
      startAt: new Date(0),
    },
  ];
}

export function createPeriodicScheduler(
  options: CreatePeriodicSchedulerOptions,
): PeriodicScheduler {
  const tickIntervalMs = options.tickIntervalMs ?? defaultTickIntervalMs;
  const now = options.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let stopped = true;

  const runOnce = async (): Promise<PeriodicSchedulerRunResult> => {
    const runAt = now();
    const result: PeriodicSchedulerRunResult = {
      createdJobs: 0,
      deduplicatedJobs: 0,
      skippedTasks: 0,
    };

    for (const task of options.tasks) {
      const scheduleWindowStart = readDueScheduleWindow(task, runAt);
      if (!scheduleWindowStart) {
        result.skippedTasks += 1;
        continue;
      }

      const enqueueResult = await options.store.enqueueScheduledJob({
        jobType: task.jobType,
        maxAttempts: task.maxAttempts ?? 3,
        payload: buildScheduledPayload(task, scheduleWindowStart),
        priority: task.priority ?? 0,
        runAfter: scheduleWindowStart,
        scheduleWindowStart,
        taskId: task.id,
      });
      if (enqueueResult.created) {
        result.createdJobs += 1;
      } else {
        result.deduplicatedJobs += 1;
      }
    }

    return result;
  };

  const tick = async () => {
    if (stopped || running) {
      return;
    }

    running = true;
    try {
      await runOnce();
    } finally {
      running = false;
    }
  };

  return {
    runOnce,
    start: async () => {
      if (!stopped) {
        return;
      }
      stopped = false;
      await tick();
      timer = setInterval(() => {
        void tick();
      }, tickIntervalMs);
    },
    stop: async () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      await options.store.close?.();
    },
  };
}

export function createPostgresPeriodicScheduler(
  options: CreatePostgresPeriodicSchedulerOptions,
): PeriodicScheduler {
  return createPeriodicScheduler({
    ...options,
    store: new PostgresPeriodicSchedulerStore(options.databaseUrl),
  });
}

function readDueScheduleWindow(task: PeriodicTaskDefinition, now: Date): Date | null {
  if (task.intervalMs <= 0) {
    throw new Error(`Periodic task ${task.id} intervalMs must be positive.`);
  }

  const elapsedMs = now.getTime() - task.startAt.getTime();
  if (elapsedMs < 0) {
    return null;
  }

  const elapsedIntervals = Math.floor(elapsedMs / task.intervalMs);
  return new Date(task.startAt.getTime() + elapsedIntervals * task.intervalMs);
}

function buildScheduledPayload(
  task: PeriodicTaskDefinition,
  scheduleWindowStart: Date,
): Record<string, unknown> {
  return {
    ...(task.payload ?? {}),
    schedule: {
      intervalMs: task.intervalMs,
      taskId: task.id,
      windowStart: scheduleWindowStart.toISOString(),
    },
  };
}

class PostgresPeriodicSchedulerStore implements PeriodicSchedulerStore {
  constructor(private readonly databaseUrl: string) {}

  async enqueueScheduledJob(input: EnqueueScheduledJobInput): Promise<EnqueueScheduledJobResult> {
    const client = new Client({ connectionString: this.databaseUrl });
    await client.connect();
    const payload = JSON.stringify(input.payload);
    const signature = `${input.jobType}:${payload}`;

    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [signature]);

      const existing = await client.query<{ id: string }>(
        `
          select id::text
          from jobs
          where job_type = $1
            and trigger = 'scheduled'
            and payload = $2::jsonb
          limit 1
        `,
        [input.jobType, payload],
      );
      const existingJobId = existing.rows[0]?.id;
      if (existingJobId) {
        await client.query("commit");
        return { created: false, jobId: existingJobId };
      }

      const jobId = randomUUID();
      await client.query(
        `
          insert into jobs (
            id,
            job_type,
            status,
            trigger,
            priority,
            payload,
            run_after,
            max_attempts
          )
          values ($1, $2, 'pending', 'scheduled', $3, $4::jsonb, $5::timestamptz, $6)
        `,
        [
          jobId,
          input.jobType,
          input.priority,
          payload,
          input.runAfter.toISOString(),
          input.maxAttempts,
        ],
      );
      await client.query("select pg_notify($1, $2)", [
        JOB_CREATED_CHANNEL,
        JSON.stringify({
          jobId,
          jobType: input.jobType,
          taskId: input.taskId,
        }),
      ]);
      await client.query("commit");
      return { created: true, jobId };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
}
