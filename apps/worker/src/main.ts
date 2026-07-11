import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { loadBootstrapRuntimeConfig } from "@llmingress/config";
import { assertPostgresDatabaseConfigured, closePostgresPools } from "@llmingress/db/client";
import { createLogger } from "@llmingress/logging";
import { createPostgresJobRunner } from "@llmingress/worker-runtime/worker-job-runner";
import { createModelRefreshJobHandler } from "@llmingress/worker-runtime/worker-model-refresh";
import {
  createDefaultPeriodicTasks,
  createPostgresPeriodicScheduler,
} from "@llmingress/worker-runtime/worker-periodic-scheduler";
import { createPriceSyncJobHandler } from "@llmingress/worker-runtime/worker-price-sync";
import { createProviderConnectivityCheckJobHandler } from "@llmingress/worker-runtime/worker-provider-connectivity-check";
import { createRetentionCleanupJobHandler } from "@llmingress/worker-runtime/worker-retention-cleanup";
import { createStaleConcurrencyReconcileJobHandler } from "@llmingress/worker-runtime/worker-stale-concurrency";

const logger = createLogger("worker");

export async function startWorker() {
  const config = loadBootstrapRuntimeConfig();
  assertPostgresDatabaseConfigured();
  logBootstrapSecurityWarnings(config.securityWarnings);
  const jobRunner = createPostgresJobRunner({
    handlers: {
      model_refresh: createModelRefreshJobHandler({}),
      provider_connectivity_check: createProviderConnectivityCheckJobHandler({}),
      price_sync: createPriceSyncJobHandler({}),
      retention_cleanup: createRetentionCleanupJobHandler({}),
      stale_concurrency_reconcile: createStaleConcurrencyReconcileJobHandler({}),
    },
    leaseMs: readWorkerJobLeaseMs(),
    pollIntervalMs: config.workerHeartbeatMs,
    shutdownGraceMs: readWorkerShutdownGraceMs(),
    workerId: readWorkerId(),
  });
  const periodicScheduler = createPostgresPeriodicScheduler({
    tasks: createDefaultPeriodicTasks(),
    tickIntervalMs: config.workerHeartbeatMs,
  });
  await jobRunner.start();
  await periodicScheduler.start();

  logger.info("[worker] started");

  return {
    async stop() {
      await periodicScheduler.stop();
      await jobRunner.stop();
      await closePostgresPools();
      logger.info("[worker] stopped");
    },
  };
}

function logBootstrapSecurityWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    logger.warn({ securityWarning: true }, warning);
  }
}

function readWorkerId(): string {
  return process.env.WORKER_ID?.trim() || `${hostname()}-${process.pid}-${randomUUID()}`;
}

function readWorkerJobLeaseMs(): number {
  return readPositiveIntegerEnv("WORKER_JOB_LEASE_MS", 60_000);
}

function readWorkerShutdownGraceMs(): number {
  return readPositiveIntegerEnv("WORKER_SHUTDOWN_GRACE_MS", 25_000);
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (rawValue === undefined) {
    return fallback;
  }
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWorker()
    .then((worker) => {
      const shutdown = () => {
        worker
          .stop()
          .then(() => process.exit(0))
          .catch((error: unknown) => {
            logger.error({ err: error }, "worker shutdown failed");
            process.exit(1);
          });
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((error: unknown) => {
      logger.error({ err: error }, "worker startup failed");
      process.exit(1);
    });
}
