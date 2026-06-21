import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createPostgresJobRunner } from "../../apps/worker/src/job-runner";
import { createPostgresPeriodicScheduler } from "../../apps/worker/src/periodic-scheduler";
import { createRetentionCleanupJobHandler } from "../../apps/worker/src/retention-cleanup";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("scheduled retention cleanup uses configurable window deletes expired data skips unexpired data and preserves aggregates", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_retention_cleanup_${randomUUID().replaceAll("-", "_")}`,
  });
  const outputDir = await mkdtemp(join(tmpdir(), "llmingress-retention-cleanup-"));
  const oldExportPath = join(outputDir, "old.jsonl");
  const newExportPath = join(outputDir, "new.jsonl");
  const now = new Date("2026-06-16T00:00:00.000Z");

  try {
    await writeFile(oldExportPath, '{"requestId":"req_retention_old_085"}\n', "utf8");
    await writeFile(newExportPath, '{"requestId":"req_retention_new_085"}\n', "utf8");
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const ids = await seedRetentionCleanupData(fixture, {
      newExportPath,
      oldExportPath,
    });

    const scheduler = createPostgresPeriodicScheduler({
      databaseUrl: fixture.databaseUrl,
      now: () => new Date("2000-01-01T00:00:00.000Z"),
      tasks: [
        {
          id: "retention-cleanup",
          intervalMs: 24 * 60 * 60 * 1000,
          jobType: "retention_cleanup",
          maxAttempts: 1,
          payload: {
            retentionDays: 30,
          },
          priority: 0,
          startAt: new Date(0),
        },
      ],
    });
    await expect(scheduler.runOnce()).resolves.toEqual({
      createdJobs: 1,
      deduplicatedJobs: 0,
      skippedTasks: 0,
    });

    const runner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: {
        retention_cleanup: createRetentionCleanupJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => now,
        }),
      },
      workerId: "retention-cleanup-worker-085",
    });

    await expect(runner.runOnce()).resolves.toBe(true);

    await expect(readRetentionState(fixture, ids)).resolves.toEqual({
      aggregateBudgetPeriods: 1,
      aggregateRateLimitWindows: 1,
      newExportJobs: 1,
      newFallbackEvents: 1,
      newRequestActivities: 1,
      newRequestCosts: 1,
      newRequestUsages: 1,
      oldExportFileDeletedMarkers: 1,
      oldExportJobs: 1,
      oldFallbackEvents: 0,
      oldRequestActivities: 0,
      oldRequestCosts: 0,
      oldRequestUsages: 0,
    });
    await expect(readRetentionJob(fixture)).resolves.toMatchObject({
      result: {
        cutoff: "2026-05-17T00:00:00.000Z",
        deletedExportFileCount: 1,
        deletedExportTaskCount: 1,
        deletedRequestActivityCount: 1,
        preservedBudgetPeriodCount: 1,
        preservedRateLimitWindowCount: 1,
        retentionDays: 30,
      },
      status: "succeeded",
      trigger: "scheduled",
    });
    await expect(pathExists(oldExportPath)).resolves.toBe(false);
    await expect(pathExists(newExportPath)).resolves.toBe(true);
  } finally {
    await fixture.dispose();
    await rm(outputDir, { force: true, recursive: true });
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type RetentionSeedIds = {
  agentApiKeyId: string;
  budgetPeriodId: string;
  newActivityId: string;
  newExportJobId: string;
  oldActivityId: string;
  oldExportJobId: string;
  rateLimitWindowId: string;
};

async function seedRetentionCleanupData(
  fixture: Fixture,
  input: {
    newExportPath: string;
    oldExportPath: string;
  },
): Promise<RetentionSeedIds> {
  const ids = {
    agentApiKeyId: randomUUID(),
    agentId: randomUUID(),
    budgetPeriodId: randomUUID(),
    newActivityId: randomUUID(),
    newExportJobId: randomUUID(),
    oldActivityId: randomUUID(),
    oldExportJobId: randomUUID(),
    providerId: randomUUID(),
    providerModelId: randomUUID(),
    rateLimitWindowId: randomUUID(),
    virtualModelId: randomUUID(),
  };

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'retention-provider', 'Retention Provider', 'https://retention.example/v1', true)
    `,
    [ids.providerId],
  );
  await fixture.query(
    `
      insert into provider_models (id, provider_id, model_id, display_name, availability)
      values ($1, $2, 'retention-model', 'Retention Model', 'available')
    `,
    [ids.providerModelId, ids.providerId],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, description, enabled)
      values ($1, 'retention-fast', 'Retention Fast', true)
    `,
    [ids.virtualModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Retention Agent', 'coding', true)",
    [ids.agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = 'llmi_ret85', key_hash = 'sha256:v1:retention-secret-hash', default_virtual_model_id = $3, enabled = true, updated_at = now() where id = $2
    `,
    [ids.agentApiKeyId, ids.agentId, ids.virtualModelId],
  );

  await insertRequestData(fixture, {
    activityId: ids.oldActivityId,
    agentApiKeyId: ids.agentApiKeyId,
    createdAt: "2026-05-01T00:00:00.000Z",
    providerId: ids.providerId,
    providerModelId: ids.providerModelId,
    requestId: "req_retention_old_085",
    virtualModelId: ids.virtualModelId,
  });
  await insertRequestData(fixture, {
    activityId: ids.newActivityId,
    agentApiKeyId: ids.agentApiKeyId,
    createdAt: "2026-06-01T00:00:00.000Z",
    providerId: ids.providerId,
    providerModelId: ids.providerModelId,
    requestId: "req_retention_new_085",
    virtualModelId: ids.virtualModelId,
  });
  await insertCompletedExportJob(fixture, {
    completedAt: "2026-05-01T00:00:00.000Z",
    exportJobId: ids.oldExportJobId,
    outputPath: input.oldExportPath,
  });
  await insertCompletedExportJob(fixture, {
    completedAt: "2026-06-01T00:00:00.000Z",
    exportJobId: ids.newExportJobId,
    outputPath: input.newExportPath,
  });
  await fixture.query(
    `
      insert into budget_periods (
        id,
        agent_id,
        period_type,
        period_start,
        period_end,
        tokens_used,
        cost_used_usd,
        created_at,
        updated_at
      )
      values (
        $1,
        $2,
        'month',
        '2026-05-01T00:00:00.000Z'::timestamptz,
        '2026-06-01T00:00:00.000Z'::timestamptz,
        1000,
        0.10000000,
        '2026-05-01T00:00:00.000Z'::timestamptz,
        '2026-05-01T00:00:00.000Z'::timestamptz
      )
    `,
    [ids.budgetPeriodId, ids.agentApiKeyId],
  );
  await fixture.query(
    `
      insert into rate_limit_windows (
        id,
        agent_id,
        limit_type,
        window_start,
        window_end,
        request_count,
        token_count,
        created_at,
        updated_at
      )
      values (
        $1,
        $2,
        'rpm',
        '2026-05-01T00:00:00.000Z'::timestamptz,
        '2026-05-01T00:01:00.000Z'::timestamptz,
        5,
        500,
        '2026-05-01T00:00:00.000Z'::timestamptz,
        '2026-05-01T00:00:00.000Z'::timestamptz
      )
    `,
    [ids.rateLimitWindowId, ids.agentApiKeyId],
  );

  return ids;
}

async function insertRequestData(
  fixture: Fixture,
  input: {
    activityId: string;
    agentApiKeyId: string;
    createdAt: string;
    providerId: string;
    providerModelId: string;
    requestId: string;
    virtualModelId: string;
  },
): Promise<void> {
  await fixture.query(
    `
      insert into request_activity (
        id,
        request_id,
        agent_id,
        virtual_model_id,
        provider_id,
        provider_model_id,
        agent_key_prefix,
        protocol,
        model,
        stream,
        status,
        http_status,
        started_at,
        completed_at,
        created_at
      )
      values (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        'llmi_ret85',
        'chat_completions',
        'retention-fast',
        false,
        'succeeded',
        200,
        $7::timestamptz,
        ($7::timestamptz + interval '1 second'),
        $7::timestamptz
      )
    `,
    [
      input.activityId,
      input.requestId,
      input.agentApiKeyId,
      input.virtualModelId,
      input.providerId,
      input.providerModelId,
      input.createdAt,
    ],
  );
  await fixture.query(
    `
      insert into request_usage (
        id,
        request_activity_id,
        agent_id,
        virtual_model_id,
        provider_model_id,
        input_tokens,
        output_tokens,
        total_tokens,
        token_source
      )
      values ($1, $2, $3, $4, $5, 10, 20, 30, 'estimated')
    `,
    [
      randomUUID(),
      input.activityId,
      input.agentApiKeyId,
      input.virtualModelId,
      input.providerModelId,
    ],
  );
  await fixture.query(
    `
      insert into request_costs (
        id,
        request_activity_id,
        agent_id,
        provider_model_id,
        total_cost_usd,
        cost_source,
        actual_cost_usd,
        baseline_cost_usd,
        savings_usd
      )
      values ($1, $2, $3, $4, 0.00100000, 'estimated', 0.00100000, 0.00300000, 0.00200000)
    `,
    [randomUUID(), input.activityId, input.agentApiKeyId, input.providerModelId],
  );
  await fixture.query(
    `
      insert into fallback_events (
        id,
        request_activity_id,
        provider_model_id,
        attempt_order,
        status,
        error_code,
        error_message,
        failed_before_first_byte,
        created_at
      )
      values ($1, $2, $3, 1, 'failed', 'provider_error', 'retention fallback', true, $4::timestamptz)
    `,
    [randomUUID(), input.activityId, input.providerModelId, input.createdAt],
  );
}

async function insertCompletedExportJob(
  fixture: Fixture,
  input: {
    completedAt: string;
    exportJobId: string;
    outputPath: string;
  },
): Promise<void> {
  await fixture.query(
    `
      insert into jobs (
        id,
        job_type,
        status,
        trigger,
        payload,
        result,
        completed_at,
        created_at,
        updated_at
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
      input.exportJobId,
      JSON.stringify({
        exportType: "jsonl_request_logs",
        lineCount: 1,
        outputPath: input.outputPath,
      }),
      input.completedAt,
    ],
  );
}

async function readRetentionState(fixture: Fixture, ids: RetentionSeedIds) {
  const result = await fixture.query<{
    aggregate_budget_periods: number;
    aggregate_rate_limit_windows: number;
    new_export_jobs: number;
    new_fallback_events: number;
    new_request_activities: number;
    new_request_costs: number;
    new_request_usages: number;
    old_export_file_deleted_markers: number;
    old_export_jobs: number;
    old_fallback_events: number;
    old_request_activities: number;
    old_request_costs: number;
    old_request_usages: number;
  }>(
    `
      select
        (select count(*)::integer from request_activity where id = $1) as old_request_activities,
        (select count(*)::integer from request_usage where request_activity_id = $1) as old_request_usages,
        (select count(*)::integer from request_costs where request_activity_id = $1) as old_request_costs,
        (select count(*)::integer from fallback_events where request_activity_id = $1) as old_fallback_events,
        (select count(*)::integer from jobs where id = $2) as old_export_jobs,
        (select count(*)::integer from jobs where id = $2 and result ? 'exportFileDeletedAt')
          as old_export_file_deleted_markers,
        (select count(*)::integer from request_activity where id = $3) as new_request_activities,
        (select count(*)::integer from request_usage where request_activity_id = $3) as new_request_usages,
        (select count(*)::integer from request_costs where request_activity_id = $3) as new_request_costs,
        (select count(*)::integer from fallback_events where request_activity_id = $3) as new_fallback_events,
        (select count(*)::integer from jobs where id = $4) as new_export_jobs,
        (select count(*)::integer from budget_periods where id = $5) as aggregate_budget_periods,
        (select count(*)::integer from rate_limit_windows where id = $6) as aggregate_rate_limit_windows
    `,
    [
      ids.oldActivityId,
      ids.oldExportJobId,
      ids.newActivityId,
      ids.newExportJobId,
      ids.budgetPeriodId,
      ids.rateLimitWindowId,
    ],
  );
  const row = result.rows[0];

  return {
    aggregateBudgetPeriods: row.aggregate_budget_periods,
    aggregateRateLimitWindows: row.aggregate_rate_limit_windows,
    newExportJobs: row.new_export_jobs,
    newFallbackEvents: row.new_fallback_events,
    newRequestActivities: row.new_request_activities,
    newRequestCosts: row.new_request_costs,
    newRequestUsages: row.new_request_usages,
    oldExportFileDeletedMarkers: row.old_export_file_deleted_markers,
    oldExportJobs: row.old_export_jobs,
    oldFallbackEvents: row.old_fallback_events,
    oldRequestActivities: row.old_request_activities,
    oldRequestCosts: row.old_request_costs,
    oldRequestUsages: row.old_request_usages,
  };
}

async function readRetentionJob(fixture: Fixture) {
  const result = await fixture.query<{
    result: unknown;
    status: string;
    trigger: string;
  }>(
    `
      select status, trigger, result
      from jobs
      where job_type = 'retention_cleanup'
      order by created_at desc
      limit 1
    `,
  );
  return result.rows[0];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
