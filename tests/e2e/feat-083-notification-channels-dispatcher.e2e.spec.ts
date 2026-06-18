import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import {
  createNotificationChannel,
  listNotificationChannels,
  normalizeNotificationChannelFormInput,
} from "../../apps/console/src/server/notification-channels";
import { createPostgresJobRunner } from "../../apps/worker/src/job-runner";
import {
  createNotificationDispatchJobHandler,
  queueNotificationEvent,
} from "../../apps/worker/src/notification-dispatcher";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("notification channels queue send retry and audit email webhook deliveries", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_notifications_${randomUUID().replaceAll("-", "_")}`,
  });
  const webhook = await startFakeWebhookServer();
  const now = new Date("2026-01-01T00:00:00.000Z");

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const emailChannel = await createNotificationChannel({
      channel: normalizeNotificationChannelFormInput({
        channelType: "email",
        displayName: "Ops Email",
        emailFrom: "alerts@llmingress.local",
        emailTo: "owner@example.com",
      }),
      databaseUrl: fixture.databaseUrl,
    });
    const webhookChannel = await createNotificationChannel({
      channel: normalizeNotificationChannelFormInput({
        channelType: "webhook",
        displayName: "Ops Webhook",
        webhookUrl: webhook.url,
      }),
      databaseUrl: fixture.databaseUrl,
    });

    await expect(listNotificationChannels(fixture.databaseUrl)).resolves.toMatchObject([
      {
        channelType: "email",
        displayName: "Ops Email",
        enabled: true,
        id: emailChannel.id,
      },
      {
        channelType: "webhook",
        displayName: "Ops Webhook",
        enabled: true,
        id: webhookChannel.id,
      },
    ]);

    const queued = await queueNotificationEvent({
      databaseUrl: fixture.databaseUrl,
      event: {
        body: "Budget is at 90%.",
        eventType: "budget_threshold",
        maxAttempts: 2,
        payload: {
          agentId: "agent-083",
          threshold: 0.9,
        },
        subject: "Budget warning",
      },
      now: () => now,
    });

    expect(queued.eventIds).toHaveLength(2);
    await expect(readNotificationStatuses(fixture)).resolves.toEqual([
      { attempt_count: 0, channel_type: "email", status: "queued" },
      { attempt_count: 0, channel_type: "webhook", status: "queued" },
    ]);

    const runner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: {
        notification_dispatch: createNotificationDispatchJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => now,
          retryBackoffMs: () => 0,
        }),
      },
      workerId: "notification-worker-083",
    });

    await expect(runner.runOnce()).resolves.toBe(true);
    await expect(readNotificationStatuses(fixture)).resolves.toEqual([
      { attempt_count: 1, channel_type: "email", status: "sent" },
      { attempt_count: 1, channel_type: "webhook", status: "retrying" },
    ]);

    await expect(runner.runOnce()).resolves.toBe(true);

    await expect(readNotificationStatuses(fixture)).resolves.toEqual([
      { attempt_count: 1, channel_type: "email", status: "sent" },
      { attempt_count: 2, channel_type: "webhook", status: "sent" },
    ]);
    await expect(readNotificationDeliveries(fixture)).resolves.toEqual([
      {
        attempt_number: 1,
        channel_type: "email",
        error_code: null,
        response_status: null,
        status: "sent",
      },
      {
        attempt_number: 1,
        channel_type: "webhook",
        error_code: "webhook_http_error",
        response_status: 500,
        status: "failed",
      },
      {
        attempt_number: 2,
        channel_type: "webhook",
        error_code: null,
        response_status: 204,
        status: "sent",
      },
    ]);
    expect(webhook.requests).toHaveLength(2);
    expect(webhook.requests[0]).toMatchObject({
      body: "Budget is at 90%.",
      eventType: "budget_threshold",
      subject: "Budget warning",
    });
    await expect(readNotificationDispatchJobs(fixture)).resolves.toEqual([
      {
        job_type: "notification_dispatch",
        status: "succeeded",
        trigger: "system",
      },
      {
        job_type: "notification_dispatch",
        status: "succeeded",
        trigger: "system",
      },
    ]);
  } finally {
    await webhook.stop();
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type NotificationStatusRow = {
  attempt_count: number;
  channel_type: string;
  status: string;
};

type NotificationDeliveryRow = {
  attempt_number: number;
  channel_type: string;
  error_code: string | null;
  response_status: number | null;
  status: string;
};

type NotificationDispatchJobRow = {
  job_type: string;
  status: string;
  trigger: string;
};

type FakeWebhookServer = {
  requests: Array<Record<string, unknown>>;
  stop: () => Promise<void>;
  url: string;
};

async function readNotificationStatuses(fixture: Fixture): Promise<NotificationStatusRow[]> {
  const result = await fixture.query<NotificationStatusRow>(
    `
      select notification_channels.channel_type,
             notification_events.status,
             notification_events.attempt_count
      from notification_events
      join notification_channels on notification_channels.id = notification_events.channel_id
      order by notification_channels.channel_type
    `,
  );
  return result.rows;
}

async function readNotificationDeliveries(fixture: Fixture): Promise<NotificationDeliveryRow[]> {
  const result = await fixture.query<NotificationDeliveryRow>(
    `
      select channel_type,
             attempt_number,
             status,
             response_status,
             error_code
      from notification_deliveries
      order by channel_type, attempt_number
    `,
  );
  return result.rows;
}

async function readNotificationDispatchJobs(
  fixture: Fixture,
): Promise<NotificationDispatchJobRow[]> {
  const result = await fixture.query<NotificationDispatchJobRow>(
    `
      select job_type, status, trigger
      from jobs
      where job_type = 'notification_dispatch'
      order by created_at, id
    `,
  );
  return result.rows;
}

async function startFakeWebhookServer(): Promise<FakeWebhookServer> {
  const requests: Array<Record<string, unknown>> = [];
  let callCount = 0;
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    callCount += 1;
    const body = await readRequestJson(request);
    requests.push(body);
    if (callCount === 1) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "temporary failure" }));
      return;
    }
    response.writeHead(204);
    response.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to allocate fake webhook port.");
  }

  return {
    requests,
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    url: `http://127.0.0.1:${address.port}/notify`,
  };
}

async function readRequestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}
