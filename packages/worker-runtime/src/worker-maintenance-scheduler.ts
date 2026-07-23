import { PostgresClient } from "@llmingress/db/client";
import {
  enqueueProviderQuotaProbeJob,
  listDueProviderQuotaProbeConnections,
} from "@llmingress/db/provider-jobs";
import { createLogger } from "@llmingress/logging";
import { readModelCatalogCacheTtlMs } from "@llmingress/provider/price-source";
import {
  cleanupExpiredOperationalData,
  readRetentionCleanupSettings,
} from "./worker-retention-cleanup.ts";
import { reconcileGatewayConcurrencyWindows } from "./worker-stale-concurrency.ts";

export type WorkerMaintenanceTask = {
  id: string;
  intervalMs: number;
  run: (signal: AbortSignal) => Promise<void>;
};

export type WorkerMaintenanceRunResult = {
  executedTasks: number;
  failedTasks: number;
  lockedTasks: number;
  skippedTasks: number;
};

export type WorkerMaintenanceScheduler = {
  runOnce: () => Promise<WorkerMaintenanceRunResult>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

type CreateMaintenanceSchedulerOptions = {
  databaseUrl?: string;
  now?: () => Date;
  tasks: WorkerMaintenanceTask[];
  tickIntervalMs?: number;
};

type CreateCoreMaintenanceTasksOptions = {
  databaseUrl?: string;
  now?: () => Date;
};

const logger = createLogger("worker");
const defaultTickIntervalMs = 30_000;
const staleConcurrencyIntervalMs = 5 * 60_000;
const providerQuotaProbeIntervalMs = 5 * 60_000;

export function createCoreMaintenanceTasks(
  options: CreateCoreMaintenanceTasksOptions = {},
): WorkerMaintenanceTask[] {
  const retention = readRetentionCleanupSettings();
  // Fail fast at startup on a malformed model catalog cache TTL rather than degrading silently at
  // refresh time (where Promise.allSettled would swallow the error).
  readModelCatalogCacheTtlMs();
  return [
    {
      id: "stale-concurrency-reconcile",
      intervalMs: staleConcurrencyIntervalMs,
      run: async (signal) => {
        if (signal.aborted) {
          return;
        }
        await reconcileGatewayConcurrencyWindows({ databaseUrl: options.databaseUrl });
      },
    },
    {
      id: "retention-cleanup",
      intervalMs: retention.intervalMs,
      run: async (signal) => {
        await cleanupExpiredOperationalData({
          databaseUrl: options.databaseUrl,
          now: options.now,
          settings: retention,
          signal,
        });
      },
    },
    {
      // Scheduling lives here rather than in the job handler so a chain broken
      // by a lost or failed job self-heals on the next cycle.
      id: "provider-quota-probe-enqueue",
      intervalMs: providerQuotaProbeIntervalMs,
      run: async (signal) => {
        const connections = await listDueProviderQuotaProbeConnections({
          databaseUrl: options.databaseUrl,
        });
        for (const connection of connections) {
          if (signal.aborted) {
            return;
          }
          await enqueueProviderQuotaProbeJob({
            databaseUrl: options.databaseUrl,
            providerConnectionId: connection.providerConnectionId,
            providerId: connection.providerId,
            source: "scheduled_probe",
          });
        }
      },
    },
  ];
}

export function createPostgresMaintenanceScheduler(
  options: CreateMaintenanceSchedulerOptions,
): WorkerMaintenanceScheduler {
  const now = options.now ?? (() => new Date());
  const tickIntervalMs = options.tickIntervalMs ?? defaultTickIntervalMs;
  const lastStartedAt = new Map<string, number>();
  const abortController = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeRun: Promise<WorkerMaintenanceRunResult> | undefined;
  let stopped = true;

  const runOnce = (): Promise<WorkerMaintenanceRunResult> => {
    if (activeRun) {
      return activeRun;
    }
    activeRun = runDueTasks().finally(() => {
      activeRun = undefined;
    });
    return activeRun;
  };

  const runDueTasks = async (): Promise<WorkerMaintenanceRunResult> => {
    const result: WorkerMaintenanceRunResult = {
      executedTasks: 0,
      failedTasks: 0,
      lockedTasks: 0,
      skippedTasks: 0,
    };

    for (const task of options.tasks) {
      assertValidTask(task);
      const currentTime = now().getTime();
      const previousStart = lastStartedAt.get(task.id);
      if (previousStart !== undefined && currentTime - previousStart < task.intervalMs) {
        result.skippedTasks += 1;
        continue;
      }
      lastStartedAt.set(task.id, currentTime);

      try {
        const acquired = await runPostgresAdvisoryLockedTask({
          databaseUrl: options.databaseUrl,
          signal: abortController.signal,
          task,
        });
        if (acquired) {
          result.executedTasks += 1;
        } else {
          result.lockedTasks += 1;
        }
      } catch (error) {
        result.failedTasks += 1;
        logger.error({ err: error, task: task.id }, "worker maintenance task failed");
      }
    }

    return result;
  };

  return {
    runOnce,
    start: async () => {
      if (!stopped) {
        return;
      }
      stopped = false;
      await runOnce();
      timer = setInterval(() => {
        if (!stopped) {
          void runOnce();
        }
      }, tickIntervalMs);
    },
    stop: async () => {
      stopped = true;
      abortController.abort();
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      await activeRun;
    },
  };
}

export async function runPostgresAdvisoryLockedTask(input: {
  databaseUrl?: string;
  signal: AbortSignal;
  task: WorkerMaintenanceTask;
}): Promise<boolean> {
  const client = new PostgresClient({ connectionString: input.databaseUrl });
  await client.connect();
  const lockName = `llmingress:worker-maintenance:${input.task.id}`;
  let acquired = false;

  try {
    const result = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtext($1)) as acquired",
      [lockName],
    );
    acquired = result.rows[0]?.acquired === true;
    if (!acquired || input.signal.aborted) {
      return false;
    }
    await input.task.run(input.signal);
    return true;
  } finally {
    if (acquired) {
      await client
        .query("select pg_advisory_unlock(hashtext($1))", [lockName])
        .catch(() => undefined);
    }
    await client.end();
  }
}

function assertValidTask(task: WorkerMaintenanceTask): void {
  if (!task.id.trim()) {
    throw new Error("Worker maintenance task id is required.");
  }
  if (!Number.isInteger(task.intervalMs) || task.intervalMs <= 0) {
    throw new Error(`Worker maintenance task ${task.id} intervalMs must be positive.`);
  }
}
