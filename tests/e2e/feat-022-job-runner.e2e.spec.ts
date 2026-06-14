import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createPostgresJobRunner, JobHandlerError } from "../../apps/worker/src/job-runner";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("worker leases job wakes on notify retries with backoff and records result once", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_job_runner_${randomUUID().replaceAll("-", "_")}`,
  });
  const jobId = randomUUID();
  const handlerCalls: Array<{ attemptNumber: number; workerId: string }> = [];
  const handlers = {
    model_refresh: async (job: { attemptNumber: number; workerId: string }) => {
      handlerCalls.push({ attemptNumber: job.attemptNumber, workerId: job.workerId });
      if (job.attemptNumber === 1) {
        throw new JobHandlerError("temporary_failure", "temporary failure");
      }
      return { attemptNumber: job.attemptNumber, ok: true };
    },
  };
  const runnerA = createPostgresJobRunner({
    databaseUrl: fixture.databaseUrl,
    handlers,
    leaseMs: 5_000,
    pollIntervalMs: 60_000,
    retryBackoffMs: () => 250,
    workerId: "worker-a",
  });
  const runnerB = createPostgresJobRunner({
    databaseUrl: fixture.databaseUrl,
    handlers,
    leaseMs: 5_000,
    pollIntervalMs: 60_000,
    retryBackoffMs: () => 250,
    workerId: "worker-b",
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await Promise.all([runnerA.start(), runnerB.start()]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await insertPendingJobAndNotify(fixture, jobId);

    await expect
      .poll(() => readJobStatus(fixture, jobId), {
        timeout: 5_000,
      })
      .toBe("succeeded");

    const job = await readJob(fixture, jobId);
    expect(job).toMatchObject({
      attempt_count: 2,
      error_code: null,
      error_message: null,
      lease_expires_at: null,
      lease_owner: null,
      status: "succeeded",
    });
    expect(job?.result).toEqual({ attemptNumber: 2, ok: true });
    expect(handlerCalls).toHaveLength(2);

    const attempts = await readJobAttempts(fixture, jobId);
    expect(attempts).toEqual([
      {
        attempt_number: 1,
        error_code: "temporary_failure",
        status: "failed",
      },
      {
        attempt_number: 2,
        error_code: null,
        status: "succeeded",
      },
    ]);
    expect(attempts.filter((attempt) => attempt.status === "succeeded")).toHaveLength(1);
  } finally {
    await Promise.all([runnerA.stop(), runnerB.stop()]);
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type JobRow = {
  attempt_count: number;
  error_code: string | null;
  error_message: string | null;
  lease_expires_at: Date | null;
  lease_owner: string | null;
  result: unknown;
  status: string;
};

type JobAttemptRow = {
  attempt_number: number;
  error_code: string | null;
  status: string;
};

async function insertPendingJobAndNotify(fixture: Fixture, jobId: string): Promise<void> {
  await fixture.query(
    `
      insert into jobs (id, job_type, status, trigger, payload, max_attempts)
      values ($1, 'model_refresh', 'pending', 'manual', $2, 2)
    `,
    [jobId, JSON.stringify({ source: "feat-022-e2e" })],
  );
  await fixture.query("select pg_notify('job_created', $1)", [JSON.stringify({ jobId })]);
}

async function readJobStatus(fixture: Fixture, jobId: string): Promise<string | null> {
  const result = await fixture.query<{ status: string }>("select status from jobs where id = $1", [
    jobId,
  ]);
  return result.rows[0]?.status ?? null;
}

async function readJob(fixture: Fixture, jobId: string): Promise<JobRow | null> {
  const result = await fixture.query<JobRow>(
    `
      select status,
             result,
             error_code,
             error_message,
             lease_owner,
             lease_expires_at,
             attempt_count
      from jobs
      where id = $1
    `,
    [jobId],
  );
  return result.rows[0] ?? null;
}

async function readJobAttempts(fixture: Fixture, jobId: string): Promise<JobAttemptRow[]> {
  const result = await fixture.query<JobAttemptRow>(
    `
      select attempt_number, status, error_code
      from job_attempts
      where job_id = $1
      order by attempt_number
    `,
    [jobId],
  );
  return result.rows;
}
