import { randomUUID } from "node:crypto";
import { createPostgresJobRunner } from "@llmingress/worker-runtime/worker-job-runner";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("Worker claims and completes a core provider maintenance job", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_worker_core_${randomUUID().replaceAll("-", "_")}`,
  });
  const jobId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into jobs (id, job_type, status, trigger, payload, max_attempts, run_after)
        values ($1, 'model_refresh', 'pending', 'manual', '{}'::jsonb, 1, now())
      `,
      [jobId],
    );

    const runner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: {
        model_refresh: async (job) => ({ handledJobId: job.id, operation: "model_refresh" }),
      },
      workerId: "worker-core-operations",
    });

    await expect(runner.runOnce()).resolves.toBe(true);
    const result = await fixture.query<{
      attempt_status: string;
      result: { handledJobId: string; operation: string };
      status: string;
    }>(
      `
        select jobs.status,
               jobs.result,
               job_attempts.status as attempt_status
        from jobs
        join job_attempts on job_attempts.job_id = jobs.id
        where jobs.id = $1
      `,
      [jobId],
    );
    expect(result.rows[0]).toEqual({
      attempt_status: "succeeded",
      result: { handledJobId: jobId, operation: "model_refresh" },
      status: "succeeded",
    });
  } finally {
    await fixture.dispose();
  }
});
