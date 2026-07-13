import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createPostgresJobRunner } from "../../packages/worker-runtime/src/worker-job-runner";

test("expired running core jobs are recovered before claiming new work", async () => {
  const fixture = await createMigratedFixture("lease_recovery_jobs");
  const jobId = randomUUID();
  const now = new Date("2026-07-10T01:00:00.000Z");
  try {
    await fixture.query(
      `
        insert into jobs (
          id, job_type, status, trigger, payload, run_after,
          lease_owner, lease_expires_at, attempt_count, max_attempts
        )
        values (
          $1, 'model_refresh', 'running', 'system', '{}'::jsonb, $2::timestamptz,
          'dead-worker', $3::timestamptz, 1, 2
        )
      `,
      [jobId, "2026-07-10T00:00:00.000Z", "2026-07-10T00:00:30.000Z"],
    );
    await fixture.query(
      `
        insert into job_attempts (id, job_id, attempt_number, worker_id, status, started_at)
        values ($1, $2, 1, 'dead-worker', 'running', $3::timestamptz)
      `,
      [randomUUID(), jobId, "2026-07-10T00:00:00.000Z"],
    );

    const runner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: { model_refresh: async (job) => ({ attemptNumber: job.attemptNumber }) },
      leaseMs: 60_000,
      now: () => now,
      workerId: "live-worker",
    });

    await expect(runner.runOnce()).resolves.toBe(true);
    await expect(readJob(fixture, jobId)).resolves.toMatchObject({
      attempt_count: 2,
      lease_owner: null,
      status: "succeeded",
    });
    await expect(readAttempts(fixture, jobId)).resolves.toEqual([
      {
        attempt_number: 1,
        error_code: "job_lease_expired",
        status: "failed",
        worker_id: "dead-worker",
      },
      {
        attempt_number: 2,
        error_code: null,
        status: "succeeded",
        worker_id: "live-worker",
      },
    ]);
  } finally {
    await fixture.dispose();
  }
});

test("active core job leases fence out a second Worker", async () => {
  const fixture = await createMigratedFixture("lease_recovery_live_workers");
  const jobId = randomUUID();
  const now = new Date("2026-07-10T01:30:00.000Z");
  let releaseFirstWorker: (() => void) | undefined;
  let firstWorkerStarted: (() => void) | undefined;
  try {
    await fixture.query(
      `
        insert into jobs (id, job_type, status, trigger, payload, run_after, max_attempts)
        values ($1, 'model_refresh', 'pending', 'system', '{}'::jsonb, $2::timestamptz, 3)
      `,
      [jobId, now.toISOString()],
    );
    const firstWorkerStartedPromise = new Promise<void>((resolve) => {
      firstWorkerStarted = resolve;
    });
    const firstRunner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: {
        model_refresh: async () => {
          firstWorkerStarted?.();
          await new Promise<void>((resolve) => {
            releaseFirstWorker = resolve;
          });
          return { worker: "first" };
        },
      },
      leaseMs: 60_000,
      now: () => now,
      workerId: "first-worker",
    });
    const secondRunner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: { model_refresh: async () => ({ worker: "second" }) },
      leaseMs: 60_000,
      now: () => now,
      workerId: "second-worker",
    });

    const firstRun = firstRunner.runOnce();
    await firstWorkerStartedPromise;
    await expect(secondRunner.runOnce()).resolves.toBe(false);
    releaseFirstWorker?.();
    await expect(firstRun).resolves.toBe(true);
    await expect(readAttempts(fixture, jobId)).resolves.toHaveLength(1);
  } finally {
    releaseFirstWorker?.();
    await fixture.dispose();
  }
});

async function createMigratedFixture(prefix: string) {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_${prefix}_${randomUUID().replaceAll("-", "_")}`,
  });
  await runMigrations({ databaseUrl: fixture.databaseUrl });
  return fixture;
}

async function readJob(fixture: Awaited<ReturnType<typeof createMigratedFixture>>, jobId: string) {
  const result = await fixture.query(
    "select status, attempt_count, lease_owner, error_code from jobs where id = $1",
    [jobId],
  );
  return result.rows[0];
}

async function readAttempts(
  fixture: Awaited<ReturnType<typeof createMigratedFixture>>,
  jobId: string,
) {
  const result = await fixture.query(
    `
      select attempt_number, worker_id, status, error_code
      from job_attempts
      where job_id = $1
      order by attempt_number
    `,
    [jobId],
  );
  return result.rows;
}
