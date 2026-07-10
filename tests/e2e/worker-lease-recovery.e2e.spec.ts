import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createPostgresJobRunner } from "../../packages/worker-runtime/src/worker-job-runner";
import { createNotificationDispatchJobHandler } from "../../packages/worker-runtime/src/worker-notification-dispatcher";

test("expired running jobs are recovered before claiming new work", async () => {
  const fixture = await createMigratedFixture("lease_recovery_jobs");
  try {
    const jobId = randomUUID();
    const now = new Date("2026-07-10T01:00:00.000Z");
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
      handlers: {
        model_refresh: async (job) => ({ attemptNumber: job.attemptNumber }),
      },
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

test("active job leases fence out a second worker until the first attempt finishes", async () => {
  const fixture = await createMigratedFixture("lease_recovery_live_workers");
  try {
    const jobId = randomUUID();
    const now = new Date("2026-07-10T01:30:00.000Z");
    await seedPendingModelRefreshJob(fixture, jobId, now);
    let releaseFirstWorker: (() => void) | undefined;
    let firstWorkerStarted: (() => void) | undefined;
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
      handlers: {
        model_refresh: async () => ({ worker: "second" }),
      },
      leaseMs: 60_000,
      now: () => now,
      workerId: "second-worker",
    });

    const firstRun = firstRunner.runOnce();
    await firstWorkerStartedPromise;
    await expect(secondRunner.runOnce()).resolves.toBe(false);
    releaseFirstWorker?.();
    await expect(firstRun).resolves.toBe(true);

    await expect(readJob(fixture, jobId)).resolves.toMatchObject({
      attempt_count: 1,
      lease_owner: null,
      status: "succeeded",
    });
    await expect(readAttempts(fixture, jobId)).resolves.toEqual([
      {
        attempt_number: 1,
        error_code: null,
        status: "succeeded",
        worker_id: "first-worker",
      },
    ]);
  } finally {
    await fixture.dispose();
  }
});

test("expired running jobs become terminal when max attempts are exhausted", async () => {
  const fixture = await createMigratedFixture("lease_recovery_terminal");
  try {
    const jobId = randomUUID();
    const now = new Date("2026-07-10T01:45:00.000Z");
    await fixture.query(
      `
        insert into jobs (
          id, job_type, status, trigger, payload, run_after,
          lease_owner, lease_expires_at, attempt_count, max_attempts
        )
        values (
          $1, 'model_refresh', 'running', 'system', '{}'::jsonb, $2::timestamptz,
          'dead-worker', $3::timestamptz, 1, 1
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
      handlers: {
        model_refresh: async () => ({ shouldNotRun: true }),
      },
      now: () => now,
      workerId: "live-worker",
    });

    await expect(runner.runOnce()).resolves.toBe(false);

    await expect(readJob(fixture, jobId)).resolves.toMatchObject({
      attempt_count: 1,
      error_code: "job_lease_expired",
      lease_owner: null,
      status: "failed",
    });
    await expect(readAttempts(fixture, jobId)).resolves.toEqual([
      {
        attempt_number: 1,
        error_code: "job_lease_expired",
        status: "failed",
        worker_id: "dead-worker",
      },
    ]);
  } finally {
    await fixture.dispose();
  }
});

test("notification jobs use payload eventIds and enqueue continuation work for oversized batches", async () => {
  const fixture = await createMigratedFixture("lease_recovery_notifications");
  try {
    const now = new Date("2026-07-10T02:00:00.000Z");
    const channelId = await seedNotificationChannel(fixture);
    const eventIds = await seedNotificationEvents({
      channelId,
      count: 51,
      fixture,
      nextAttemptAt: now,
    });
    const deliveredEventIds: string[] = [];
    const handler = createNotificationDispatchJobHandler({
      databaseUrl: fixture.databaseUrl,
      deliverWebhook: async (input) => {
        deliveredEventIds.push(input.payload.eventId);
        return { status: "sent" };
      },
      maxBatchSize: 50,
      now: () => now,
    });

    await expect(
      handler(runningNotificationJob({ eventIds }, "worker-notification-batch")),
    ).resolves.toMatchObject({ processed: 50, sent: 50 });

    expect(deliveredEventIds).toHaveLength(50);
    await expect(countNotificationStatuses(fixture)).resolves.toEqual({
      queued: 1,
      sent: 50,
    });
    await expect(readContinuationEventIds(fixture)).resolves.toEqual([eventIds[50]]);
  } finally {
    await fixture.dispose();
  }
});

test("legacy sending notifications with no delivery lease are recovered and delivered", async () => {
  const fixture = await createMigratedFixture("lease_recovery_legacy_sending");
  try {
    const now = new Date("2026-07-10T02:30:00.000Z");
    const channelId = await seedNotificationChannel(fixture);
    const [eventId] = await seedNotificationEvents({
      channelId,
      count: 1,
      fixture,
      nextAttemptAt: now,
      status: "sending",
      attemptCount: 1,
    });
    const deliveredEventIds: string[] = [];
    const handler = createNotificationDispatchJobHandler({
      databaseUrl: fixture.databaseUrl,
      deliverWebhook: async (input) => {
        deliveredEventIds.push(input.payload.eventId);
        return { status: "sent" };
      },
      now: () => now,
    });

    await expect(
      handler(runningNotificationJob({ eventIds: [eventId] }, "worker-legacy-sending")),
    ).resolves.toMatchObject({ processed: 1, sent: 1 });

    expect(deliveredEventIds).toEqual([eventId]);
    await expect(readNotificationEvent(fixture, eventId)).resolves.toMatchObject({
      attempt_count: 2,
      delivery_owner: null,
      status: "sent",
    });
  } finally {
    await fixture.dispose();
  }
});

test("notification delivery completion is fenced by delivery owner and attempt", async () => {
  const fixture = await createMigratedFixture("lease_recovery_notification_fence");
  try {
    const now = new Date("2026-07-10T03:00:00.000Z");
    const channelId = await seedNotificationChannel(fixture);
    const [eventId] = await seedNotificationEvents({
      channelId,
      count: 1,
      fixture,
      nextAttemptAt: now,
    });
    const handler = createNotificationDispatchJobHandler({
      databaseUrl: fixture.databaseUrl,
      deliverWebhook: async (input) => {
        await fixture.query(
          `
            update notification_events
            set delivery_owner = 'new-owner',
                delivery_expires_at = $2::timestamptz
            where id = $1
          `,
          [input.payload.eventId, "2026-07-10T03:01:00.000Z"],
        );
        return { status: "sent" };
      },
      now: () => now,
    });

    await handler(runningNotificationJob({ eventIds: [eventId] }, "old-owner"));

    await expect(readNotificationEvent(fixture, eventId)).resolves.toMatchObject({
      delivery_owner: "new-owner",
      sent_at: null,
      status: "sending",
    });
  } finally {
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

async function seedPendingModelRefreshJob(
  fixture: Awaited<ReturnType<typeof createMigratedFixture>>,
  jobId: string,
  runAfter: Date,
): Promise<void> {
  await fixture.query(
    `
      insert into jobs (id, job_type, status, trigger, payload, run_after, max_attempts)
      values ($1, 'model_refresh', 'pending', 'system', '{}'::jsonb, $2::timestamptz, 3)
    `,
    [jobId, runAfter.toISOString()],
  );
}

function runningNotificationJob(payload: unknown, workerId: string) {
  return {
    attemptNumber: 1,
    id: randomUUID(),
    jobType: "notification_dispatch",
    maxAttempts: 3,
    payload,
    priority: 0,
    signal: new AbortController().signal,
    trigger: "system",
    workerId,
  };
}

async function seedNotificationChannel(
  fixture: Awaited<ReturnType<typeof createMigratedFixture>>,
): Promise<string> {
  const channelId = randomUUID();
  await fixture.query(
    `
      insert into notification_channels (id, channel_type, display_name, enabled, config)
      values ($1, 'webhook', 'Worker Lease Hook', true, '{"url":"http://127.0.0.1:9/webhook"}'::jsonb)
    `,
    [channelId],
  );
  return channelId;
}

async function seedNotificationEvents(input: {
  attemptCount?: number;
  channelId: string;
  count: number;
  fixture: Awaited<ReturnType<typeof createMigratedFixture>>;
  nextAttemptAt: Date;
  status?: "queued" | "sending";
}): Promise<string[]> {
  const eventIds = Array.from({ length: input.count }, () => randomUUID());
  for (const eventId of eventIds) {
    await input.fixture.query(
      `
        insert into notification_events (
          id, channel_id, event_type, subject, body, payload,
          status, attempt_count, max_attempts, next_attempt_at
        )
        values (
          $1, $2, 'fallback_exhaustion', 'Subject', 'Body', '{}'::jsonb,
          $4, $5, 3, $3::timestamptz
        )
      `,
      [
        eventId,
        input.channelId,
        input.nextAttemptAt.toISOString(),
        input.status ?? "queued",
        input.attemptCount ?? 0,
      ],
    );
  }
  return eventIds;
}

async function readJob(fixture: Awaited<ReturnType<typeof createMigratedFixture>>, jobId: string) {
  const result = await fixture.query(
    `
      select status, attempt_count, lease_owner, error_code
      from jobs
      where id = $1
    `,
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

async function countNotificationStatuses(
  fixture: Awaited<ReturnType<typeof createMigratedFixture>>,
) {
  const result = await fixture.query(
    `
      select status, count(*)::integer as count
      from notification_events
      group by status
      order by status
    `,
  );
  return Object.fromEntries(result.rows.map((row) => [row.status, row.count]));
}

async function readContinuationEventIds(
  fixture: Awaited<ReturnType<typeof createMigratedFixture>>,
): Promise<string[]> {
  const result = await fixture.query<{ event_ids: string[] }>(
    `
      select array(
        select jsonb_array_elements_text(payload->'eventIds')
      ) as event_ids
      from jobs
      where job_type = 'notification_dispatch'
        and status = 'pending'
        and payload->>'source' = 'notification_continuation'
      order by created_at desc
      limit 1
    `,
  );
  return result.rows[0]?.event_ids ?? [];
}

async function readNotificationEvent(
  fixture: Awaited<ReturnType<typeof createMigratedFixture>>,
  eventId: string,
) {
  const result = await fixture.query(
    `
      select status, delivery_owner, sent_at
           , attempt_count
      from notification_events
      where id = $1
    `,
    [eventId],
  );
  return result.rows[0];
}
