import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import {
  createNotificationDispatchJobHandler,
  queueNotificationEvent,
} from "../../packages/worker-runtime/src/worker-notification-dispatcher";

test("notification webhooks block private targets by default and use event id idempotency keys when allowlisted", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_webhook_egress_${randomUUID().replaceAll("-", "_")}`,
  });
  const hits: Array<{ idempotencyKey?: string; path?: string }> = [];
  const server = await startHttpServer((request, response) => {
    hits.push({
      idempotencyKey: request.headers["idempotency-key"] as string | undefined,
      path: request.url,
    });
    response.end("ok");
  });
  const originalAllowedHosts = process.env.WORKER_WEBHOOK_ALLOWED_HOSTS;

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const blockedChannelId = await seedNotificationChannel(fixture, server.url);
    const blocked = await queueNotificationEvent({
      channelIds: [blockedChannelId],
      databaseUrl: fixture.databaseUrl,
      event: {
        body: "Body",
        eventType: "fallback_exhaustion",
        maxAttempts: 1,
        subject: "Subject",
      },
      now: () => new Date("2026-07-10T04:00:00.000Z"),
    });
    const blockedHandler = createNotificationDispatchJobHandler({
      databaseUrl: fixture.databaseUrl,
      now: () => new Date("2026-07-10T04:00:01.000Z"),
    });

    await expect(
      blockedHandler(runningNotificationJob({ eventIds: blocked.eventIds }, "worker-blocked")),
    ).resolves.toMatchObject({ failed: 1, processed: 1 });
    expect(hits).toEqual([]);
    await expect(readNotificationEvent(fixture, blocked.eventIds[0])).resolves.toMatchObject({
      last_error_code: "webhook_target_blocked",
      status: "failed",
    });

    process.env.WORKER_WEBHOOK_ALLOWED_HOSTS = "127.0.0.1";
    const allowedChannelId = await seedNotificationChannel(fixture, server.url);
    const allowed = await queueNotificationEvent({
      channelIds: [allowedChannelId],
      databaseUrl: fixture.databaseUrl,
      event: {
        body: "Body",
        eventType: "fallback_exhaustion",
        subject: "Subject",
      },
      now: () => new Date("2026-07-10T04:00:02.000Z"),
    });
    const allowedHandler = createNotificationDispatchJobHandler({
      databaseUrl: fixture.databaseUrl,
      now: () => new Date("2026-07-10T04:00:03.000Z"),
    });

    await expect(
      allowedHandler(runningNotificationJob({ eventIds: allowed.eventIds }, "worker-allowed")),
    ).resolves.toMatchObject({ processed: 1, sent: 1 });
    expect(hits).toEqual([
      {
        idempotencyKey: allowed.eventIds[0],
        path: "/webhook",
      },
    ]);
  } finally {
    if (originalAllowedHosts === undefined) {
      delete process.env.WORKER_WEBHOOK_ALLOWED_HOSTS;
    } else {
      process.env.WORKER_WEBHOOK_ALLOWED_HOSTS = originalAllowedHosts;
    }
    await server.close();
    await fixture.dispose();
  }
});

async function startHttpServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ close: () => Promise<void>; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP server did not bind to a TCP port.");
  }
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    url: `http://127.0.0.1:${address.port}/webhook`,
  };
}

async function seedNotificationChannel(
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>,
  url: string,
): Promise<string> {
  const channelId = randomUUID();
  await fixture.query(
    `
      insert into notification_channels (id, channel_type, display_name, enabled, config)
      values ($1, 'webhook', 'Webhook Egress Hook', true, $2::jsonb)
    `,
    [channelId, JSON.stringify({ url })],
  );
  return channelId;
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

async function readNotificationEvent(
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>,
  eventId?: string,
) {
  const result = await fixture.query(
    `
      select status, last_error_code
      from notification_events
      where id = $1
    `,
    [eventId],
  );
  return result.rows[0];
}
