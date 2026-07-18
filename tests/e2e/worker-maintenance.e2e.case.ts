import { randomUUID } from "node:crypto";
import {
  createCoreMaintenanceTasks,
  createPostgresMaintenanceScheduler,
  type WorkerMaintenanceTask,
} from "@llmingress/worker-runtime/worker-maintenance-scheduler";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("direct Worker maintenance is locked, deletes expired data, and creates no jobs", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_worker_maintenance_${randomUUID().replaceAll("-", "_")}`,
  });
  const now = new Date("2026-07-11T00:00:00.000Z");

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedExpiredData(fixture, now);

    const first = createPostgresMaintenanceScheduler({
      databaseUrl: fixture.databaseUrl,
      tasks: createCoreMaintenanceTasks({ databaseUrl: fixture.databaseUrl, now: () => now }),
    });
    const result = await first.runOnce();
    expect(result.executedTasks).toBe(2);

    const counts = await fixture.query<{
      attempts: number;
      events: number;
      jobs: number;
      requests: number;
    }>(`
      select
        (select count(*)::int from job_attempts) as attempts,
        (select count(*)::int from provider_health_events) as events,
        (select count(*)::int from jobs) as jobs,
        (select count(*)::int from request_activity) as requests
    `);
    expect(counts.rows[0]).toEqual({ attempts: 0, events: 1, jobs: 0, requests: 0 });

    const constraint = await fixture.query<{ definition: string }>(`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'jobs'::regclass
        and conname = 'jobs_job_type_check'
    `);
    expect(constraint.rows[0]?.definition).toContain("model_refresh");
    expect(constraint.rows[0]?.definition).not.toContain("retention_cleanup");
    expect(constraint.rows[0]?.definition).not.toContain("stale_concurrency_reconcile");

    await first.stop();
    await expectAdvisoryLockFencing(fixture.databaseUrl);
  } finally {
    await fixture.dispose();
  }
});

async function expectAdvisoryLockFencing(databaseUrl: string): Promise<void> {
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  let executions = 0;
  const task: WorkerMaintenanceTask = {
    id: "maintenance-lock-e2e",
    intervalMs: 60_000,
    run: async () => {
      executions += 1;
      started?.();
      await releasePromise;
    },
  };
  const first = createPostgresMaintenanceScheduler({ databaseUrl, tasks: [task] });
  const second = createPostgresMaintenanceScheduler({ databaseUrl, tasks: [task] });

  const firstRun = first.runOnce();
  await startedPromise;
  const secondResult = await second.runOnce();
  release?.();
  await firstRun;

  expect(executions).toBe(1);
  expect(secondResult.lockedTasks).toBe(1);
  await first.stop();
  await second.stop();
}

async function seedExpiredData(
  fixture: { query: (text: string, values?: readonly unknown[]) => Promise<unknown> },
  now: Date,
): Promise<void> {
  const requestId = randomUUID();
  const apiKeyId = randomUUID();
  const jobId = randomUUID();
  const preservedEventId = randomUUID();
  const expiredEventId = randomUUID();
  const providerId = randomUUID();
  const providerConnectionId = randomUUID();
  const old = new Date(now.getTime() - 40 * 86_400_000).toISOString();
  const oldJob = new Date(now.getTime() - 10 * 86_400_000).toISOString();

  await fixture.query(
    `insert into request_activity
      (id, request_id, api_key_id, api_key_prefix, protocol, status, created_at)
     values ($1, 'retention-old-request', $2, 'llmi_test', 'responses', 'succeeded', $3)`,
    [requestId, apiKeyId, old],
  );
  await fixture.query(
    `insert into request_usage
      (id, request_activity_id, api_key_id, token_source, created_at)
     values ($1, $2, $3, 'estimated', $4)`,
    [randomUUID(), requestId, apiKeyId, old],
  );
  await fixture.query(
    `insert into request_costs
      (id, request_activity_id, api_key_id, cost_source, created_at)
     values ($1, $2, $3, 'estimated', $4)`,
    [randomUUID(), requestId, apiKeyId, old],
  );
  await fixture.query(
    `insert into fallback_events
      (id, request_activity_id, attempt_order, status, created_at)
     values ($1, $2, 1, 'failed', $3)`,
    [randomUUID(), requestId, old],
  );
  await fixture.query(
    `insert into jobs
      (id, job_type, status, trigger, payload, max_attempts, run_after, created_at, updated_at, completed_at)
     values ($1, 'model_refresh', 'succeeded', 'manual', '{}'::jsonb, 1, $2, $2, $2, $2)`,
    [jobId, oldJob],
  );
  await fixture.query(
    `insert into job_attempts
      (id, job_id, attempt_number, worker_id, status, started_at, finished_at)
     values ($1, $2, 1, 'retention-worker', 'succeeded', $3, $3)`,
    [randomUUID(), jobId, oldJob],
  );
  for (const eventId of [preservedEventId, expiredEventId]) {
    await fixture.query(
      `insert into provider_health_events
        (id, provider_id, provider_connection_id, trigger, status, observed_at)
       values ($1, $2, $3, 'worker_probe', 'unhealthy', $4)`,
      [eventId, providerId, providerConnectionId, old],
    );
  }
  await fixture.query(
    `insert into provider_health_summary
      (id, provider_id, provider_connection_id, last_event_id, status)
     values ($1, $2, $3, $4, 'unhealthy')`,
    [randomUUID(), providerId, providerConnectionId, preservedEventId],
  );
}
