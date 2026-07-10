import { pathToFileURL } from "node:url";
import { loadBootstrapRuntimeConfig } from "@llmingress/config";
import { assertPostgresDatabaseConfigured, closePostgresPools } from "@llmingress/db/client";
import { createLogger } from "@llmingress/logging";
import { createBackupJobHandler } from "@llmingress/worker-runtime/worker-backup";
import { createBillingReconciliationJobHandler } from "@llmingress/worker-runtime/worker-billing-reconciliation";
import { createBudgetThresholdAlertsJobHandler } from "@llmingress/worker-runtime/worker-budget-threshold-alerts";
import { createCostReportExportJobHandler } from "@llmingress/worker-runtime/worker-cost-report-export";
import { createFallbackExhaustionAlertsJobHandler } from "@llmingress/worker-runtime/worker-fallback-exhaustion-alerts";
import { createPostgresJobRunner } from "@llmingress/worker-runtime/worker-job-runner";
import { createJsonlRequestLogExportJobHandler } from "@llmingress/worker-runtime/worker-jsonl-export";
import { createModelRefreshJobHandler } from "@llmingress/worker-runtime/worker-model-refresh";
import { createNotificationDispatchJobHandler } from "@llmingress/worker-runtime/worker-notification-dispatcher";
import {
  createDefaultPeriodicTasks,
  createPostgresPeriodicScheduler,
} from "@llmingress/worker-runtime/worker-periodic-scheduler";
import { createPriceSyncJobHandler } from "@llmingress/worker-runtime/worker-price-sync";
import { createProviderConnectivityCheckJobHandler } from "@llmingress/worker-runtime/worker-provider-connectivity-check";
import { createProviderFailureAlertsJobHandler } from "@llmingress/worker-runtime/worker-provider-failure-alerts";
import { createRateLimitAlertsJobHandler } from "@llmingress/worker-runtime/worker-rate-limit-alerts";
import { createRetentionCleanupJobHandler } from "@llmingress/worker-runtime/worker-retention-cleanup";
import { createStaleConcurrencyReconcileJobHandler } from "@llmingress/worker-runtime/worker-stale-concurrency";
import { createWebhookEventExportJobHandler } from "@llmingress/worker-runtime/worker-webhook-export";

const logger = createLogger("worker");

export async function startWorker() {
  const config = loadBootstrapRuntimeConfig();
  assertPostgresDatabaseConfigured();
  logBootstrapSecurityWarnings(config.securityWarnings);
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
