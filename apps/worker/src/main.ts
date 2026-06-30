import { pathToFileURL } from "node:url";
import { loadBootstrapRuntimeConfig } from "@llmingress/config";
import { assertPostgresDatabaseConfigured } from "@llmingress/db/client";
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
  assertPostgresDatabaseConfigured();
  const jobRunner =
    options.jobRunner ??
    createPostgresJobRunner({
      handlers: {
        model_refresh: createModelRefreshJobHandler({}),
        provider_connectivity_check: createProviderConnectivityCheckJobHandler({}),
        provider_failure_alerts: createProviderFailureAlertsJobHandler({}),
        billing_reconciliation: createBillingReconciliationJobHandler({}),
        backup: createBackupJobHandler({}),
        budget_threshold_alerts: createBudgetThresholdAlertsJobHandler({}),
        price_sync: createPriceSyncJobHandler({}),
        cost_report_export: createCostReportExportJobHandler({}),
        fallback_exhaustion_alerts: createFallbackExhaustionAlertsJobHandler({}),
        jsonl_export: createJsonlRequestLogExportJobHandler({}),
        notification_dispatch: createNotificationDispatchJobHandler({}),
        rate_limit_alerts: createRateLimitAlertsJobHandler({}),
        webhook_export: createWebhookEventExportJobHandler({}),
        retention_cleanup: createRetentionCleanupJobHandler({}),
        stale_reservation_cleanup: createStaleReservationCleanupJobHandler({}),
      },
      pollIntervalMs: config.workerHeartbeatMs,
      workerId: readWorkerId(),
    });
  const periodicScheduler =
    options.periodicScheduler ??
    createPostgresPeriodicScheduler({
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
