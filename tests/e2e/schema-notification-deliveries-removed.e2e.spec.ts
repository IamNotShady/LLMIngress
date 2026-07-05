import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import {
  createNotificationDispatchJobHandler,
  queueNotificationEvent,
} from "../../packages/db/src/worker-notification-dispatcher";

test("notification retry state survives without notification_deliveries", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_notifications_e2e_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await expect(tableExists(fixture, "notification_deliveries")).resolves.toBe(false);

    const channelId = randomUUID();
    await fixture.query(
      `
        insert into notification_channels (id, channel_type, display_name, enabled, config)
        values ($1, 'webhook', 'Schema Hook', true, '{"url":"http://127.0.0.1:9/webhook"}'::jsonb)
      `,
      [channelId],
    );
    const queued = await queueNotificationEvent({
      channelIds: [channelId],
      databaseUrl: fixture.databaseUrl,
      event: {
        body: "Body",
        eventType: "fallback_exhaustion",
        maxAttempts: 1,
        subject: "Subject",
      },
      now: () => new Date("2026-07-05T00:00:00.000Z"),
    });
    const handler = createNotificationDispatchJobHandler({
      databaseUrl: fixture.databaseUrl,
      deliverWebhook: async () => ({
        errorCode: "webhook_http_error",
        errorMessage: "Webhook returned HTTP 500.",
        responseStatus: 500,
        status: "failed",
      }),
      now: () => new Date("2026-07-05T00:00:01.000Z"),
    });

    await expect(
      handler({
        attemptNumber: 1,
        id: randomUUID(),
        jobType: "notification_dispatch",
        maxAttempts: 3,
        payload: {},
        priority: 0,
        trigger: "system",
        workerId: "worker-schema-notifications",
      }),
    ).resolves.toMatchObject({ failed: 1, processed: 1 });

    await expect(readNotificationEvent(fixture, queued.eventIds[0])).resolves.toMatchObject({
      attempt_count: 1,
      last_error_code: "webhook_http_error",
      status: "failed",
    });
  } finally {
    await fixture.dispose();
  }
});

async function tableExists(
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>,
  tableName: string,
) {
  const result = await fixture.query<{ exists: boolean }>(
    `
      select exists (
        select 1
        from information_schema.tables
        where table_schema = 'public'
          and table_name = $1
          and table_type = 'BASE TABLE'
      )
    `,
    [tableName],
  );
  return result.rows[0]?.exists ?? false;
}

async function readNotificationEvent(
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>,
  eventId?: string,
) {
  const result = await fixture.query<{
    attempt_count: number;
    last_error_code: string | null;
    status: string;
  }>(
    `
      select attempt_count, last_error_code, status
      from notification_events
      where id = $1
    `,
    [eventId],
  );
  return result.rows[0];
}
