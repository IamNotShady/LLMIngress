import { randomUUID } from "node:crypto";
import { createPostgresPeriodicScheduler } from "@llmingress/db/worker-periodic-scheduler";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("worker scheduler enqueues due tasks skips not due tasks deduplicates notifies and schedules stale reservation cleanup", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_periodic_scheduler_${randomUUID().replaceAll("-", "_")}`,
  });
  const listener = new Client({ connectionString: fixture.databaseUrl });
  const notifications: unknown[] = [];

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await listener.connect();
    listener.on("notification", (message) => {
      if (message.channel === "job_created" && message.payload) {
        notifications.push(JSON.parse(message.payload));
      }
    });
    await listener.query("listen job_created");

    const scheduler = createPostgresPeriodicScheduler({
      databaseUrl: fixture.databaseUrl,
      now: () => new Date("2026-06-16T00:10:00.000Z"),
      tasks: [
        {
          id: "stale-cleanup",
          intervalMs: 300_000,
          jobType: "stale_reservation_cleanup",
          maxAttempts: 1,
          payload: {},
          priority: 0,
          startAt: new Date("2026-06-16T00:00:00.000Z"),
        },
        {
          id: "future-retention",
          intervalMs: 300_000,
          jobType: "retention_cleanup",
          maxAttempts: 1,
          payload: { retentionDays: 30 },
          priority: 0,
          startAt: new Date("2026-06-16T00:15:00.000Z"),
        },
      ],
    });

    await expect(scheduler.runOnce()).resolves.toEqual({
      createdJobs: 1,
      deduplicatedJobs: 0,
      skippedTasks: 1,
    });
    await expect.poll(() => notifications.length).toBe(1);
    await expect(readScheduledJobs(fixture)).resolves.toEqual([
      {
        job_type: "stale_reservation_cleanup",
        max_attempts: 1,
        payload: {
          schedule: {
            intervalMs: 300_000,
            taskId: "stale-cleanup",
            windowStart: "2026-06-16T00:10:00.000Z",
          },
        },
        run_after: "2026-06-16T00:10:00.000Z",
        status: "pending",
        trigger: "scheduled",
      },
    ]);
    expect(notifications[0]).toMatchObject({
      jobType: "stale_reservation_cleanup",
      taskId: "stale-cleanup",
    });

    await expect(scheduler.runOnce()).resolves.toEqual({
      createdJobs: 0,
      deduplicatedJobs: 1,
      skippedTasks: 1,
    });
    await expect.poll(() => notifications.length).toBe(1);
    await expect(readScheduledJobs(fixture)).resolves.toHaveLength(1);
  } finally {
    await listener.end().catch(() => undefined);
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type ScheduledJobRow = {
  job_type: string;
  max_attempts: number;
  payload: unknown;
  run_after: string;
  status: string;
  trigger: string;
};

async function readScheduledJobs(fixture: Fixture): Promise<ScheduledJobRow[]> {
  const result = await fixture.query<ScheduledJobRow>(
    `
      select job_type,
             status,
             trigger,
             payload,
             max_attempts,
             to_char(run_after at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as run_after
      from jobs
      where trigger = 'scheduled'
      order by created_at, id
    `,
  );
  return result.rows;
}
