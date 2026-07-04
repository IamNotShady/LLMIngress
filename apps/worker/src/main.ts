import { pathToFileURL } from "node:url";
import { loadBootstrapRuntimeConfig } from "@llmingress/config";
import { assertPostgresDatabaseConfigured } from "@llmingress/db/client";
import { createBackupJobHandler } from "@llmingress/db/worker-backup";
import { createBillingReconciliationJobHandler } from "@llmingress/db/worker-billing-reconciliation";
import { createBudgetThresholdAlertsJobHandler } from "@llmingress/db/worker-budget-threshold-alerts";
import { createCostReportExportJobHandler } from "@llmingress/db/worker-cost-report-export";
import { createFallbackExhaustionAlertsJobHandler } from "@llmingress/db/worker-fallback-exhaustion-alerts";
import { createPostgresJobRunner } from "@llmingress/db/worker-job-runner";
import { createJsonlRequestLogExportJobHandler } from "@llmingress/db/worker-jsonl-export";
import { createModelRefreshJobHandler } from "@llmingress/db/worker-model-refresh";
import { createNotificationDispatchJobHandler } from "@llmingress/db/worker-notification-dispatcher";
import {
  createDefaultPeriodicTasks,
  createPostgresPeriodicScheduler,
} from "@llmingress/db/worker-periodic-scheduler";
import { createPriceSyncJobHandler } from "@llmingress/db/worker-price-sync";
import { createProviderConnectivityCheckJobHandler } from "@llmingress/db/worker-provider-connectivity-check";
import { createProviderFailureAlertsJobHandler } from "@llmingress/db/worker-provider-failure-alerts";
import { createRateLimitAlertsJobHandler } from "@llmingress/db/worker-rate-limit-alerts";
import { createRetentionCleanupJobHandler } from "@llmingress/db/worker-retention-cleanup";
import { createStaleConcurrencyReconcileJobHandler } from "@llmingress/db/worker-stale-concurrency";
import { createStaleReservationCleanupJobHandler } from "@llmingress/db/worker-stale-reservations";
import { createWebhookEventExportJobHandler } from "@llmingress/db/worker-webhook-export";

export async function startWorker() {
  const config = loadBootstrapRuntimeConfig();
  assertPostgresDatabaseConfigured();
  const jobRunner = createPostgresJobRunner({
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
      stale_concurrency_reconcile: createStaleConcurrencyReconcileJobHandler({}),
      stale_reservation_cleanup: createStaleReservationCleanupJobHandler({}),
    },
    pollIntervalMs: config.workerHeartbeatMs,
    workerId: readWorkerId(),
  });
  const periodicScheduler = createPostgresPeriodicScheduler({
    tasks: createDefaultPeriodicTasks(),
    tickIntervalMs: config.workerHeartbeatMs,
  });
  await jobRunner.start();
  await periodicScheduler.start();

  console.log("[worker] started");

  return {
    async stop() {
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
