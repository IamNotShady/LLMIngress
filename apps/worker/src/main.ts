import { pathToFileURL } from "node:url";
import { loadBootstrapRuntimeConfig } from "@llmingress/config";
import { createBackupJobHandler } from "./backup.js";
import { createBillingReconciliationJobHandler } from "./billing-reconciliation.js";
import { createBudgetThresholdAlertsJobHandler } from "./budget-threshold-alerts.js";
import { createCostReportExportJobHandler } from "./cost-report-export.js";
import { createFallbackExhaustionAlertsJobHandler } from "./fallback-exhaustion-alerts.js";
import { createPostgresJobRunner, type JobRunner } from "./job-runner.js";
import { createJsonlRequestLogExportJobHandler } from "./jsonl-export.js";
import { createModelRefreshJobHandler } from "./model-refresh.js";
import { createNotificationDispatchJobHandler } from "./notification-dispatcher.js";
import {
  createDefaultPeriodicTasks,
  createPostgresPeriodicScheduler,
  type PeriodicScheduler,
} from "./periodic-scheduler.js";
import { createPriceSyncJobHandler } from "./price-sync.js";
import { createProviderConnectivityCheckJobHandler } from "./provider-connectivity-check.js";
import { createProviderFailureAlertsJobHandler } from "./provider-failure-alerts.js";
import { createRateLimitAlertsJobHandler } from "./rate-limit-alerts.js";
import { createRetentionCleanupJobHandler } from "./retention-cleanup.js";
import { createStaleReservationCleanupJobHandler } from "./stale-reservations.js";
import { createWebhookEventExportJobHandler } from "./webhook-export.js";

type StartWorkerOptions = {
  jobRunner?: JobRunner;
  periodicScheduler?: PeriodicScheduler;
};

export async function startWorker(options: StartWorkerOptions = {}) {
  const config = loadBootstrapRuntimeConfig();
  const jobRunner =
    options.jobRunner ??
    createPostgresJobRunner({
      databaseUrl: config.databaseUrl,
      handlers: {
        model_refresh: createModelRefreshJobHandler({ databaseUrl: config.databaseUrl }),
        provider_connectivity_check: createProviderConnectivityCheckJobHandler({
          databaseUrl: config.databaseUrl,
        }),
        provider_failure_alerts: createProviderFailureAlertsJobHandler({
          databaseUrl: config.databaseUrl,
        }),
        billing_reconciliation: createBillingReconciliationJobHandler({
          databaseUrl: config.databaseUrl,
        }),
        backup: createBackupJobHandler({
          databaseUrl: config.databaseUrl,
        }),
        budget_threshold_alerts: createBudgetThresholdAlertsJobHandler({
          databaseUrl: config.databaseUrl,
        }),
        price_sync: createPriceSyncJobHandler({ databaseUrl: config.databaseUrl }),
        cost_report_export: createCostReportExportJobHandler({
          databaseUrl: config.databaseUrl,
        }),
        fallback_exhaustion_alerts: createFallbackExhaustionAlertsJobHandler({
          databaseUrl: config.databaseUrl,
        }),
        jsonl_export: createJsonlRequestLogExportJobHandler({
          databaseUrl: config.databaseUrl,
        }),
        notification_dispatch: createNotificationDispatchJobHandler({
          databaseUrl: config.databaseUrl,
        }),
        rate_limit_alerts: createRateLimitAlertsJobHandler({
          databaseUrl: config.databaseUrl,
        }),
        webhook_export: createWebhookEventExportJobHandler({
          databaseUrl: config.databaseUrl,
        }),
        retention_cleanup: createRetentionCleanupJobHandler({
          databaseUrl: config.databaseUrl,
        }),
        stale_reservation_cleanup: createStaleReservationCleanupJobHandler({
          databaseUrl: config.databaseUrl,
        }),
      },
      pollIntervalMs: config.workerHeartbeatMs,
      workerId: readWorkerId(),
    });
  const periodicScheduler =
    options.periodicScheduler ??
    createPostgresPeriodicScheduler({
      databaseUrl: config.databaseUrl,
      tasks: createDefaultPeriodicTasks(),
      tickIntervalMs: config.workerHeartbeatMs,
    });
  await jobRunner.start();
  await periodicScheduler.start();

  const timer = setInterval(() => {
    console.log("[worker] heartbeat");
  }, config.workerHeartbeatMs);

  console.log("[worker] started");

  return {
    async stop() {
      clearInterval(timer);
      await periodicScheduler.stop();
      await jobRunner.stop();
      console.log("[worker] stopped");
    },
  };
}

function readWorkerId(): string {
  return process.env.WORKER_ID?.trim() || `worker-${process.pid}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWorker()
    .then((worker) => {
      const shutdown = () => {
        worker
          .stop()
          .then(() => process.exit(0))
          .catch((error: unknown) => {
            console.error(error);
            process.exit(1);
          });
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
