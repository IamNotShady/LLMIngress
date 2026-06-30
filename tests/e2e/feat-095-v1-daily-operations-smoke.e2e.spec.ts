import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { getConsoleUsageSummary } from "../../apps/console/src/server/usage";
import { getPrometheusMetricsDocument } from "../../apps/gateway/src/metrics";
import { createBackupJobHandler } from "../../apps/worker/src/backup";
import { evaluateBudgetThresholdAlerts } from "../../apps/worker/src/budget-threshold-alerts";
import { createCostReportExportJobHandler } from "../../apps/worker/src/cost-report-export";
import { evaluateFallbackExhaustionAlerts } from "../../apps/worker/src/fallback-exhaustion-alerts";
import { createPostgresJobRunner } from "../../apps/worker/src/job-runner";
import { createJsonlRequestLogExportJobHandler } from "../../apps/worker/src/jsonl-export";
import { createNotificationDispatchJobHandler } from "../../apps/worker/src/notification-dispatcher";
import { evaluateProviderFailureAlerts } from "../../apps/worker/src/provider-failure-alerts";
import { evaluateRateLimitAlerts } from "../../apps/worker/src/rate-limit-alerts";
import { createRetentionCleanupJobHandler } from "../../apps/worker/src/retention-cleanup";
import { createWebhookEventExportJobHandler } from "../../apps/worker/src/webhook-export";
import {
  createTestPostgresFixture,
  runMigrations,
  shippedSqlMigrations,
} from "../../packages/db/src/index";
import { getMigrationStatusFromDatabase } from "../../packages/db/src/migration-status";
import { buildOpenTelemetryTracePayload } from "../../packages/observability/src/traces";
import { buildV1DailyOperationsSmokePlan } from "../support/v1-daily-operations-smoke";

test("v1 daily operations smoke verifies breakdowns exports alerts metrics traces backup migration retention", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_v1_daily_ops_${randomUUID().replaceAll("-", "_")}`,
  });
  const outputDir = await mkdtemp(join(tmpdir(), "llmingress-daily-ops-"));
  const plan = buildV1DailyOperationsSmokePlan({
    outputDir,
    webhookUrl: "http://127.0.0.1:9999/daily-operations-webhook?token=sk-secret-095",
  });
  const deliveredWebhookEvents: unknown[] = [];
  const deliveredNotifications: unknown[] = [];

  try {
    await writeFile(plan.paths.oldExport, '{"requestId":"req_daily_old_095"}\n', "utf8");
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedDailyOperationsData(fixture, plan);

    const usage = await getConsoleUsageSummary({
      databaseUrl: fixture.databaseUrl,
      now: plan.now,
      window: "24h",
    });
    expect(usage).toMatchObject({
      failureCount: 4,
      requestCount: 5,
      totalCostUsd: "0.01230000",
      totalSavingsUsd: "0.02000000",
      totalTokens: 160,
    });
    expect(usage.agentBreakdowns).toEqual([
      expect.objectContaining({
        label: "Daily Ops Agent",
        requestCount: 5,
      }),
    ]);
    expect(usage.virtualModelBreakdowns).toEqual([
      expect.objectContaining({
        label: "Daily Ops Fast (daily-ops-fast)",
        requestCount: 5,
      }),
    ]);

    await insertOperationsJobs(fixture, plan, [seeded.successRequestId, seeded.failedRequestId]);
    const runner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: {
        backup: createBackupJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => plan.now,
        }),
        cost_report_export: createCostReportExportJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => plan.now,
        }),
        jsonl_export: createJsonlRequestLogExportJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => plan.now,
        }),
        notification_dispatch: createNotificationDispatchJobHandler({
          databaseUrl: fixture.databaseUrl,
          deliverWebhook: async (input) => {
            deliveredNotifications.push(input.payload);
            return { responseStatus: 204, status: "sent" };
          },
          now: () => plan.now,
        }),
        retention_cleanup: createRetentionCleanupJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => plan.now,
        }),
        webhook_export: createWebhookEventExportJobHandler({
          databaseUrl: fixture.databaseUrl,
          deliverWebhook: async (input) => {
            deliveredWebhookEvents.push(input.record);
            return { responseStatus: 204, status: "sent" };
          },
          now: () => plan.now,
        }),
      },
      now: () => plan.now,
      workerId: "v1-daily-ops-worker-095",
    });

    await expect(runJobRunnerUntilIdle(runner, 8)).resolves.toBeGreaterThanOrEqual(4);
    await expectJsonlExport(plan.paths.jsonlExport, seeded);
    await expectCostReport(plan.paths.costReport, usage);
    expect(deliveredWebhookEvents).toEqual([
      expect.objectContaining({ eventType: "request", requestId: seeded.failedRequestId }),
      expect.objectContaining({ eventType: "fallback", requestId: seeded.failedRequestId }),
      expect.objectContaining({ eventType: "error", requestId: seeded.failedRequestId }),
    ]);
    expect(JSON.stringify(deliveredWebhookEvents)).not.toContain("sk-secret-095");

    await expect(
      evaluateBudgetThresholdAlerts({
        databaseUrl: fixture.databaseUrl,
        now: () => plan.now,
        payload: plan.alerts.budgetThreshold,
      }),
    ).resolves.toMatchObject({ queuedAlertCount: 1 });
    await expect(
      evaluateRateLimitAlerts({
        databaseUrl: fixture.databaseUrl,
        now: () => plan.now,
        payload: plan.alerts.rateLimit,
      }),
    ).resolves.toMatchObject({ queuedAlertCount: 1 });
    await expect(
      evaluateProviderFailureAlerts({
        databaseUrl: fixture.databaseUrl,
        now: () => plan.now,
        payload: plan.alerts.providerFailure,
      }),
    ).resolves.toMatchObject({ queuedAlertCount: 1 });
    await expect(
      evaluateFallbackExhaustionAlerts({
        databaseUrl: fixture.databaseUrl,
        now: () => plan.now,
        payload: plan.alerts.fallbackExhaustion,
      }),
    ).resolves.toMatchObject({ queuedAlertCount: 1 });
    await expect(runJobRunnerUntilIdle(runner, 8)).resolves.toBeGreaterThanOrEqual(1);
    expect(deliveredNotifications).toHaveLength(4);
    await expect(readNotificationEventTypes(fixture)).resolves.toEqual([
      "budget_threshold",
      "fallback_exhaustion",
      "provider_failure",
      "rate_limit_high_frequency",
    ]);

    const metrics = await getPrometheusMetricsDocument({ databaseUrl: fixture.databaseUrl });
    expect(metrics.body).toContain(
      'llmingress_gateway_requests_total{protocol="chat_completions",provider="openai",model="gpt-4.1-mini",status="succeeded"} 2',
    );
    expect(metrics.body).toContain("llmingress_worker_jobs_total");
    expect(metrics.body).toContain("llmingress_provider_health_consecutive_failures");
    expect(metrics.body).not.toContain("sk-secret-095");

    const tracePayload = buildOpenTelemetryTracePayload({
      serviceName: "llmingress-daily-operations-smoke",
      spans: plan.traceSpans,
    });
    const traceJson = JSON.stringify(tracePayload);
    expect(traceJson).toContain("req_daily_success_095");
    expect(traceJson).toContain("job_daily_backup_095");
    expect(traceJson).toContain("openai");
    expect(traceJson).not.toContain("sk-secret-095");

    const backupArtifact = JSON.parse(await readFile(plan.paths.backup, "utf8"));
    expect(backupArtifact).toMatchObject({
      kind: "llmingress.backup",
      mode: "manual",
      version: 1,
    });
    expect(backupArtifact.tables.config.providers).toHaveLength(1);
    expect(backupArtifact.tables.operational.request_activity.length).toBeGreaterThanOrEqual(2);

    const migrationStatus = await getMigrationStatusFromDatabase({
      databaseUrl: fixture.databaseUrl,
      migrations: shippedSqlMigrations,
    });
    expect(migrationStatus).toMatchObject({
      pendingCount: 0,
      status: "up_to_date",
    });
    expect(migrationStatus.migrateCheckHealth).toMatchObject({
      command: "pnpm run db:migrate:check",
      status: "ready",
    });

    await insertRetentionJob(fixture, plan);
    await expect(runJobRunnerUntilIdle(runner, 3)).resolves.toBeGreaterThanOrEqual(1);
    await expect(readRetentionState(fixture, seeded)).resolves.toEqual({
      currentRequestCount: 5,
      oldExportFileDeletedMarkers: 1,
      oldExportJobCount: 1,
      oldRequestCount: 0,
      preservedBudgetPeriodCount: 1,
      preservedRateLimitWindowCount: 1,
    });
    await expect(pathExists(plan.paths.oldExport)).resolves.toBe(false);
    await expect(pathExists(plan.paths.jsonlExport)).resolves.toBe(true);
  } finally {
    await fixture.dispose();
    await rm(outputDir, { force: true, recursive: true });
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type DailyOperationsSeed = {
  agentApiKeyId: string;
  budgetPeriodId: string;
  failedActivityId: string;
  failedRequestId: string;
  oldActivityId: string;
  oldExportJobId: string;
  providerId: string;
  providerModelId: string;
  rateLimitWindowId: string;
  successActivityId: string;
  successRequestId: string;
  virtualModelId: string;
};

function isoOffset(base: Date, offsetMs: number): string {
  return new Date(base.getTime() + offsetMs).toISOString();
}

function monthStartIso(value: Date): string {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1)).toISOString();
}

function nextMonthStartIso(value: Date): string {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1)).toISOString();
}

async function seedDailyOperationsData(
  fixture: Fixture,
  plan: ReturnType<typeof buildV1DailyOperationsSmokePlan>,
): Promise<DailyOperationsSeed> {
  const ids = {
    agentApiKeyId: randomUUID(),
    agentId: randomUUID(),
    budgetPeriodId: randomUUID(),
    failedActivityId: randomUUID(),
    fallbackEventId: randomUUID(),
    healthEventId: randomUUID(),
    healthSummaryId: randomUUID(),
    oldActivityId: randomUUID(),
    oldExportJobId: randomUUID(),
    providerApiKeyId: randomUUID(),
    providerId: randomUUID(),
    providerModelId: randomUUID(),
    rateLimitWindowId: randomUUID(),
    successActivityId: randomUUID(),
    virtualModelId: randomUUID(),
  };

  await fixture.query(
    `
      insert into providers (
        id, provider_type, provider_key, display_name, base_url, enabled
      )
      values ($1, 'api_key', 'openai', 'Daily Ops OpenAI', 'https://api.openai.example/v1', true)
    `,
    [ids.providerId],
  );
  await fixture.query(
    `
      insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
      values ($1, $2, 'sk-daily95', '{"ciphertext":"ciphertext-daily-095","iv":"iv","authTag":"tag","keyId":"daily-key","algorithm":"aes-256-gcm","version":1}'::jsonb, 'daily-key')
    `,
    [ids.providerApiKeyId, ids.providerId],
  );
  await fixture.query(
    `
      insert into provider_models (id, provider_id, model_id, display_name, availability)
      values ($1, $2, 'gpt-4.1-mini', 'GPT 4.1 Mini', 'available')
    `,
    [ids.providerModelId, ids.providerId],
  );
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, 'daily-ops-fast', 'Daily Ops Fast', true)",
    [ids.virtualModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Daily Ops Agent', 'coding', true)",
    [ids.agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = 'llmi_daily95', key_hash = 'sha256:v1:daily-ops-agent-key-hash-095', default_virtual_model_id = $3, enabled = true, updated_at = now() where id = $2
    `,
    [ids.agentApiKeyId, ids.agentId, ids.virtualModelId],
  );
  await fixture.query(
    `
      insert into agent_limits (id, agent_id, limit_type, period, limit_value, unit, enabled)
      values ($1, $2, 'budget', 'month', 10.000000, 'usd', true)
    `,
    [randomUUID(), ids.agentApiKeyId],
  );
  await fixture.query(
    `
      insert into notification_channels (id, channel_type, display_name, enabled, config)
      values ($1, 'webhook', 'Daily Ops Webhook', true, $2::jsonb)
    `,
    [randomUUID(), JSON.stringify({ url: plan.webhookUrl })],
  );
  await fixture.query(
    `
      insert into budget_periods (
        id, agent_id, period_type, period_start, period_end,
        tokens_used, cost_used_usd, reserved_cost_usd, created_at, updated_at
      )
      values (
        $1, $2, 'month',
        $3::timestamptz,
        $4::timestamptz,
        160, 9.25000000, 0.00000000,
        $5::timestamptz, $5::timestamptz
      )
    `,
    [
      ids.budgetPeriodId,
      ids.agentApiKeyId,
      monthStartIso(plan.now),
      nextMonthStartIso(plan.now),
      plan.now.toISOString(),
    ],
  );
  await fixture.query(
    `
      insert into rate_limit_windows (
        id, agent_id, limit_type, window_start, window_end,
        request_count, token_count, created_at, updated_at
      )
      values (
        $1, $2, 'rpm',
        $3::timestamptz,
        $4::timestamptz,
        3, 0, $5::timestamptz, $5::timestamptz
      )
    `,
    [
      ids.rateLimitWindowId,
      ids.agentApiKeyId,
      isoOffset(plan.now, -10 * 60 * 1000),
      isoOffset(plan.now, -9 * 60 * 1000),
      plan.now.toISOString(),
    ],
  );

  await insertRequestActivity(fixture, {
    activityId: ids.successActivityId,
    agentApiKeyId: ids.agentApiKeyId,
    completedAt: isoOffset(plan.now, -5 * 60 * 1000 + 1000),
    createdAt: isoOffset(plan.now, -5 * 60 * 1000),
    httpStatus: 200,
    latencyMs: 120,
    model: "daily-ops-fast",
    providerId: ids.providerId,
    providerModelId: ids.providerModelId,
    requestId: "req_daily_success_095",
    status: "succeeded",
    virtualModelId: ids.virtualModelId,
  });
  await insertUsageCostSavings(fixture, {
    activityId: ids.successActivityId,
    agentApiKeyId: ids.agentApiKeyId,
    inputTokens: 100,
    outputTokens: 40,
    providerModelId: ids.providerModelId,
    savingsUsd: "0.02000000",
    totalCostUsd: "0.01230000",
    totalTokens: 140,
    virtualModelId: ids.virtualModelId,
  });
  await insertRequestActivity(fixture, {
    activityId: ids.failedActivityId,
    agentApiKeyId: ids.agentApiKeyId,
    completedAt: isoOffset(plan.now, -4 * 60 * 1000 + 1000),
    createdAt: isoOffset(plan.now, -4 * 60 * 1000),
    errorCode: "provider_request_failed",
    errorMessage: "provider failed with Bearer sk-secret-095",
    httpStatus: 502,
    latencyMs: 55,
    model: "daily-ops-fast",
    providerId: ids.providerId,
    providerModelId: ids.providerModelId,
    requestId: "req_daily_fallback_exhausted_095",
    status: "failed",
    virtualModelId: ids.virtualModelId,
  });
  await insertUsageCostSavings(fixture, {
    activityId: ids.failedActivityId,
    agentApiKeyId: ids.agentApiKeyId,
    inputTokens: 15,
    outputTokens: 5,
    providerModelId: ids.providerModelId,
    savingsUsd: "0.00000000",
    totalCostUsd: "0.00000000",
    totalTokens: 20,
    virtualModelId: ids.virtualModelId,
  });
  await fixture.query(
    `
      insert into fallback_events (
        id, request_activity_id, provider_model_id, attempt_order, status,
        error_code, error_message, failed_before_first_byte, created_at
      )
      values ($1, $2, $3, 1, 'failed', 'provider_request_failed',
              'fallback failed with Bearer sk-secret-095', true, $4::timestamptz)
    `,
    [
      ids.fallbackEventId,
      ids.failedActivityId,
      ids.providerModelId,
      isoOffset(plan.now, -4 * 60 * 1000 + 500),
    ],
  );

  for (let index = 0; index < 3; index += 1) {
    await insertRequestActivity(fixture, {
      activityId: randomUUID(),
      agentApiKeyId: ids.agentApiKeyId,
      completedAt: isoOffset(plan.now, -3 * 60 * 1000 + index * 1000),
      createdAt: isoOffset(plan.now, -3 * 60 * 1000 + index * 1000),
      errorCode: "rate_limit_exceeded",
      errorMessage: "RPM limit exceeded",
      httpStatus: 429,
      latencyMs: 1,
      model: "daily-ops-fast",
      requestId: `req_daily_rate_limit_${index}_095`,
      status: "failed",
      virtualModelId: ids.virtualModelId,
    });
  }

  await insertRequestActivity(fixture, {
    activityId: ids.oldActivityId,
    agentApiKeyId: ids.agentApiKeyId,
    completedAt: isoOffset(plan.now, -45 * 24 * 60 * 60 * 1000 + 1000),
    createdAt: isoOffset(plan.now, -45 * 24 * 60 * 60 * 1000),
    httpStatus: 200,
    latencyMs: 10,
    model: "daily-ops-fast",
    providerId: ids.providerId,
    providerModelId: ids.providerModelId,
    requestId: "req_daily_old_095",
    status: "succeeded",
    virtualModelId: ids.virtualModelId,
  });
  await fixture.query(
    `
      insert into provider_health_events (
        id, provider_id, provider_model_id, trigger, status,
        error_code, error_message, latency_ms, observed_at
      )
      values ($1, $2, $3, 'worker_probe', 'unhealthy', 'provider_timeout',
              'provider timeout with sk-secret-095', 5000, $4::timestamptz)
    `,
    [ids.healthEventId, ids.providerId, ids.providerModelId, plan.now.toISOString()],
  );
  await fixture.query(
    `
      insert into provider_health_summary (
        id, provider_id, provider_model_id, last_event_id, status,
        consecutive_failures, last_failure_at, updated_at
      )
      values ($1, $2, $3, $4, 'unhealthy', 2, $5::timestamptz, $5::timestamptz)
    `,
    [
      ids.healthSummaryId,
      ids.providerId,
      ids.providerModelId,
      ids.healthEventId,
      plan.now.toISOString(),
    ],
  );
  await fixture.query(
    `
      insert into jobs (
        id, job_type, status, trigger, payload, result, completed_at, created_at, updated_at
      )
      values (
        $1,
        'jsonl_export',
        'succeeded',
        'manual',
        '{}'::jsonb,
        $2::jsonb,
        $3::timestamptz,
        $3::timestamptz,
        $3::timestamptz
      )
    `,
    [
      ids.oldExportJobId,
      JSON.stringify({
        exportType: "jsonl_request_logs",
        lineCount: 1,
        outputPath: plan.paths.oldExport,
      }),
      isoOffset(plan.now, -45 * 24 * 60 * 60 * 1000 + 1000),
    ],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Daily operations smoke config')",
  );

  return {
    agentApiKeyId: ids.agentApiKeyId,
    budgetPeriodId: ids.budgetPeriodId,
    failedActivityId: ids.failedActivityId,
    failedRequestId: "req_daily_fallback_exhausted_095",
    oldActivityId: ids.oldActivityId,
    oldExportJobId: ids.oldExportJobId,
    providerId: ids.providerId,
    providerModelId: ids.providerModelId,
    rateLimitWindowId: ids.rateLimitWindowId,
    successActivityId: ids.successActivityId,
    successRequestId: "req_daily_success_095",
    virtualModelId: ids.virtualModelId,
  };
}

async function insertRequestActivity(
  fixture: Fixture,
  input: {
    activityId: string;
    agentApiKeyId: string;
    completedAt: string;
    createdAt: string;
    errorCode?: string;
    errorMessage?: string;
    httpStatus: number;
    latencyMs: number;
    model: string;
    providerId?: string;
    providerModelId?: string;
    requestId: string;
    status: "failed" | "succeeded";
    virtualModelId: string;
  },
): Promise<void> {
  await fixture.query(
    `
      insert into request_activity (
        id, request_id, agent_id, virtual_model_id, provider_id,
        provider_model_id, agent_key_prefix, protocol, model, stream,
        status, error_code, error_message, http_status, latency_ms,
        started_at, completed_at, created_at
      )
      values (
        $1, $2, $3, $4, $5, $6, 'llmi_daily95', 'chat_completions',
        $7, false, $8, $9, $10, $11, $12,
        $13::timestamptz, $14::timestamptz, $13::timestamptz
      )
    `,
    [
      input.activityId,
      input.requestId,
      input.agentApiKeyId,
      input.virtualModelId,
      input.providerId ?? null,
      input.providerModelId ?? null,
      input.model,
      input.status,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      input.httpStatus,
      input.latencyMs,
      input.createdAt,
      input.completedAt,
    ],
  );
}

async function insertUsageCostSavings(
  fixture: Fixture,
  input: {
    activityId: string;
    agentApiKeyId: string;
    inputTokens: number;
    outputTokens: number;
    providerModelId: string;
    savingsUsd: string;
    totalCostUsd: string;
    totalTokens: number;
    virtualModelId: string;
  },
): Promise<void> {
  await fixture.query(
    `
      insert into request_usage (
        id, request_activity_id, agent_id, virtual_model_id,
        provider_model_id, input_tokens, output_tokens, total_tokens, token_source
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, 'provider')
    `,
    [
      randomUUID(),
      input.activityId,
      input.agentApiKeyId,
      input.virtualModelId,
      input.providerModelId,
      input.inputTokens,
      input.outputTokens,
      input.totalTokens,
    ],
  );
  await fixture.query(
    `
      insert into request_costs (
        id, request_activity_id, agent_id, provider_model_id,
        total_cost_usd, cost_source, baseline_provider_model_id,
        actual_cost_usd, baseline_cost_usd, savings_usd, savings_percent
      )
      values ($1, $2, $3, $4, $5, 'estimated', $4, $5, $6, $7, 61.162790)
    `,
    [
      randomUUID(),
      input.activityId,
      input.agentApiKeyId,
      input.providerModelId,
      input.totalCostUsd,
      String(Number(input.totalCostUsd) + Number(input.savingsUsd)),
      input.savingsUsd,
    ],
  );
}

async function insertOperationsJobs(
  fixture: Fixture,
  plan: ReturnType<typeof buildV1DailyOperationsSmokePlan>,
  requestIds: string[],
): Promise<void> {
  await insertJob(fixture, {
    id: "00000000-0000-4000-8000-000000000951",
    jobType: "jsonl_export",
    payload: {
      outputPath: plan.paths.jsonlExport,
      requestIds,
    },
    priority: 50,
    trigger: "manual",
  });
  await insertJob(fixture, {
    id: "00000000-0000-4000-8000-000000000952",
    jobType: "cost_report_export",
    payload: {
      outputPath: plan.paths.costReport,
      window: "24h",
    },
    priority: 40,
    trigger: "manual",
  });
  await insertJob(fixture, {
    id: "00000000-0000-4000-8000-000000000953",
    jobType: "webhook_export",
    payload: {
      requestIds: [requestIds[1]],
      webhookUrl: plan.webhookUrl,
    },
    priority: 30,
    trigger: "manual",
  });
  await insertJob(fixture, {
    id: "00000000-0000-4000-8000-000000000954",
    jobType: "backup",
    payload: {
      outputPath: plan.paths.backup,
    },
    priority: 20,
    trigger: "manual",
  });
}

async function insertRetentionJob(
  fixture: Fixture,
  plan: ReturnType<typeof buildV1DailyOperationsSmokePlan>,
): Promise<void> {
  await insertJob(fixture, {
    id: "00000000-0000-4000-8000-000000000955",
    jobType: "retention_cleanup",
    payload: plan.retention,
    priority: -10,
    trigger: "scheduled",
  });
}

async function insertJob(
  fixture: Fixture,
  input: {
    id: string;
    jobType: string;
    payload: unknown;
    priority: number;
    trigger: "manual" | "scheduled" | "system";
  },
): Promise<void> {
  await fixture.query(
    `
      insert into jobs (id, job_type, status, trigger, priority, payload, max_attempts)
      values ($1, $2, 'pending', $3, $4, $5::jsonb, 1)
    `,
    [input.id, input.jobType, input.trigger, input.priority, JSON.stringify(input.payload)],
  );
}

async function runJobRunnerUntilIdle(
  runner: ReturnType<typeof createPostgresJobRunner>,
  maxRuns: number,
): Promise<number> {
  let processed = 0;
  for (let index = 0; index < maxRuns; index += 1) {
    if (!(await runner.runOnce())) {
      return processed;
    }
    processed += 1;
  }
  return processed;
}

async function expectJsonlExport(outputPath: string, seeded: DailyOperationsSeed): Promise<void> {
  const records = (await readFile(outputPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records.map((record) => record.requestId)).toEqual([
    seeded.successRequestId,
    seeded.failedRequestId,
  ]);
  expect(JSON.stringify(records)).not.toContain("sk-secret-095");
}

async function expectCostReport(
  outputPath: string,
  usage: Awaited<ReturnType<typeof getConsoleUsageSummary>>,
): Promise<void> {
  const report = JSON.parse(await readFile(outputPath, "utf8"));
  expect(report).toMatchObject({
    exportType: "cost_report",
    summary: {
      failureCount: usage.failureCount,
      requestCount: usage.requestCount,
      totalCostUsd: usage.totalCostUsd,
      totalSavingsUsd: usage.totalSavingsUsd,
      totalTokens: usage.totalTokens,
    },
  });
  expect(report.breakdowns.agents[0]).toMatchObject({
    label: "Daily Ops Agent",
    requestCount: 5,
  });
}

async function readNotificationEventTypes(fixture: Fixture): Promise<string[]> {
  const result = await fixture.query<{ event_type: string }>(
    `
      select distinct event_type
      from notification_events
      order by event_type
    `,
  );
  return result.rows.map((row) => row.event_type);
}

async function readRetentionState(
  fixture: Fixture,
  seeded: DailyOperationsSeed,
): Promise<{
  currentRequestCount: number;
  oldExportFileDeletedMarkers: number;
  oldExportJobCount: number;
  oldRequestCount: number;
  preservedBudgetPeriodCount: number;
  preservedRateLimitWindowCount: number;
}> {
  const result = await fixture.query<{
    current_request_count: string;
    old_export_file_deleted_markers: string;
    old_export_job_count: string;
    old_request_count: string;
    preserved_budget_period_count: string;
    preserved_rate_limit_window_count: string;
  }>(
    `
      select
        (select count(*)::text from request_activity where request_id <> 'req_daily_old_095')
          as current_request_count,
        (select count(*)::text from request_activity where id = $1)
          as old_request_count,
        (select count(*)::text from jobs where id = $2)
          as old_export_job_count,
        (select count(*)::text from jobs where id = $2 and result ? 'exportFileDeletedAt')
          as old_export_file_deleted_markers,
        (select count(*)::text from budget_periods where id = $3)
          as preserved_budget_period_count,
        (select count(*)::text from rate_limit_windows where id = $4)
          as preserved_rate_limit_window_count
    `,
    [seeded.oldActivityId, seeded.oldExportJobId, seeded.budgetPeriodId, seeded.rateLimitWindowId],
  );
  const row = result.rows[0];
  return {
    currentRequestCount: Number(row?.current_request_count ?? 0),
    oldExportFileDeletedMarkers: Number(row?.old_export_file_deleted_markers ?? 0),
    oldExportJobCount: Number(row?.old_export_job_count ?? 0),
    oldRequestCount: Number(row?.old_request_count ?? 0),
    preservedBudgetPeriodCount: Number(row?.preserved_budget_period_count ?? 0),
    preservedRateLimitWindowCount: Number(row?.preserved_rate_limit_window_count ?? 0),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
